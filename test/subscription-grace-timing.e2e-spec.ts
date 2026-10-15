import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { BillingDomain } from '../src/billing/billing-domain.js';
import { CommunicationEngine } from '../src/communication/engine.js';
import { LifecycleService } from '../src/billing/lifecycle.service.js';
import { SecretVault } from '../src/billing/secret-vault.js';

describe('persisted grace windows and corrective SQL migration (ephemeral DB only)', () => {
  let db: PGlite, socket: PGLiteSocketServer, prisma: PrismaClient;
  let company: string, plan: string;
  const domain = new BillingDomain();
  const network = vi.fn(() => { throw Error('External network forbidden'); });
  beforeAll(async () => {
    db = new PGlite();
    const root = new URL('../prisma/migrations/', import.meta.url);
    for (const name of (await readdir(root)).sort())
      if (name !== 'migration_lock.toml') await db.exec(await readFile(new URL(`${name}/migration.sql`, root), 'utf8'));
    socket = new PGLiteSocketServer({ db, host: '127.0.0.1', port: 0 }); await socket.start();
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: `postgresql://test:test@${socket.getServerConn()}/test`, max: 1 }) });
  }, 30000);
  beforeEach(async () => {
    await db.exec('TRUNCATE "Company", "Plan" CASCADE');
    company = randomUUID(); plan = randomUUID();
    await prisma.company.create({ data: { id: company, name: 'Temporal fixture', slug: company, status: 'ACTIVE' } });
    await prisma.plan.create({ data: { id: plan, code: plan, name: 'Fixture', monthlyPriceCents: 199 } });
    vi.stubEnv('BILLING_GRACE_DAYS', '3'); vi.stubGlobal('fetch', network);
  });
  afterEach(() => { expect(network).not.toHaveBeenCalled(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
  afterAll(async () => { await prisma?.$disconnect(); await socket?.stop(); await db?.close(); });
  const engine = () => new CommunicationEngine(prisma as never, new SecretVault(), {} as never, { get() { throw Error('Transport forbidden'); } } as never);
  const count = (event: string) => prisma.globalCommunicationOutbox.count({ where: { companyId: company, event } });
  async function subscription(extra = {}) {
    return prisma.subscription.create({ data: { companyId: company, planId: plan, status: 'ACTIVE', gateway: 'STRIPE', environment: 'SANDBOX', currentPeriodStart: new Date(Date.now() - 86400000), currentPeriodEnd: new Date(Date.now() + 86400000), ...extra } });
  }
  it('a freshly PAST_DUE legacy zero window does not capture grace even after the transaction-start clock is stale', async () => {
    const sub = await subscription({ status: 'PENDING', currentPeriodEnd: null });
    await prisma.$transaction(async tx => {
      const [start] = await tx.$queryRaw<{ at: Date }[]>`SELECT CURRENT_TIMESTAMP AS at`;
      await pause(40); const changed = new Date(); expect(changed.getTime()).toBeGreaterThan(start.at.getTime());
      await tx.subscription.update({ where: { id: sub.id }, data: { status: 'PAST_DUE', graceEndsAt: changed, updatedAt: changed } });
    });
    expect(await count('SUBSCRIPTION_GRACE_PERIOD')).toBe(0);
    await engine().temporal(); expect(await count('SUBSCRIPTION_GRACE_PERIOD')).toBe(0);
  });
  it.each(['FAILED', 'OVERDUE'] as const)('zero-day %s persists no phantom grace, preserves a paid ACTIVE subscription, and stays idempotent', async status => {
    vi.stubEnv('BILLING_GRACE_DAYS', '0');
    const paid = await subscription();
    const sub = await subscription({ status: 'PENDING', currentPeriodEnd: null });
    const p = await prisma.payment.create({ data: { companyId: company, subscriptionId: sub.id, planId: plan, gateway: 'STRIPE', environment: 'SANDBOX', amountCents: 199, status: 'PENDING', creationState: 'CREATED', externalPaymentId: 'fixture-payment' } });
    const event = { environment: 'SANDBOX' as const, eventId: randomUUID(), type: `PAYMENT_${status}`, externalPaymentId: 'fixture-payment', externalReference: p.id, companyId: company, planId: plan, status, amountCents: 199, currency: 'BRL' };
    await prisma.$transaction(async tx => { await pause(30); await domain.payment(tx, 'STRIPE', event); });
    await prisma.$transaction(tx => domain.payment(tx, 'STRIPE', event));
    expect(await prisma.payment.findUnique({ where: { id: p.id } })).toMatchObject({ status });
    expect(await prisma.subscription.findUnique({ where: { id: sub.id } })).toMatchObject({ status: 'PAST_DUE', graceEndsAt: null });
    expect(await prisma.subscription.findUnique({ where: { id: paid.id } })).toEqual(paid);
    expect(await count(`PAYMENT_${status}`)).toBe(1); expect(await count('SUBSCRIPTION_GRACE_PERIOD')).toBe(0);
    await engine().temporal(); expect(await count('SUBSCRIPTION_GRACE_PERIOD')).toBe(0);
  });
  it('zero-day provider PAST_DUE preserves the paid deadline without turning it into grace', async () => {
    vi.stubEnv('BILLING_GRACE_DAYS', '0'); const sub = await subscription({ externalSubscriptionId: 'mandate' });
    await prisma.$transaction(tx => domain.subscription(tx, 'STRIPE', { kind: 'subscription', environment: 'SANDBOX', type: 'SUBSCRIPTION_PAST_DUE', eventId: 'provider-event', externalSubscriptionId: 'mandate', externalReference: sub.id, status: 'PAST_DUE' }));
    expect(await prisma.subscription.findUnique({ where: { id: sub.id } })).toMatchObject({ status: 'PAST_DUE', graceEndsAt: sub.currentPeriodEnd });
    expect(await count('SUBSCRIPTION_GRACE_PERIOD')).toBe(0);
    expect(await prisma.company.findUnique({ where: { id: company } })).toMatchObject({ status: 'ACTIVE', isActive: true });
  });
  it('positive grace waits for persisted paid-period end; temporal producer captures at the boundary once, even without a status change', async () => {
    const start = new Date(Date.now() + 5000), end = new Date(start.getTime() + 3 * 86400000);
    const sub = await subscription({ currentPeriodEnd: start });
    await prisma.subscription.update({ where: { id: sub.id }, data: { status: 'PAST_DUE', graceEndsAt: end } });
    expect(await count('SUBSCRIPTION_GRACE_PERIOD')).toBe(0); expect(await engine().temporal()).toEqual({ inserted: 0 });
    const [boundary] = await prisma.$queryRaw<{ early: boolean; due: boolean; ended: boolean }[]>`
      SELECT kalend_subscription_grace_due(${start}::timestamp,${end}::timestamp,${sub.updatedAt}::timestamp,${new Date(start.getTime()-1)}::timestamp) AS early,
        kalend_subscription_grace_due(${start}::timestamp,${end}::timestamp,${sub.updatedAt}::timestamp,${start}::timestamp) AS due,
        kalend_subscription_grace_due(${start}::timestamp,${end}::timestamp,${sub.updatedAt}::timestamp,${end}::timestamp) AS ended`;
    expect(boundary).toEqual({ early: false, due: true, ended: false });
    await pause(Math.max(0, start.getTime() - Date.now() + 50));
    expect(await engine().temporal()).toEqual({ inserted: 1 }); expect(await engine().temporal()).toEqual({ inserted: 0 });
    await prisma.subscription.update({ where: { id: sub.id }, data: { status: 'ACTIVE' } });
    await prisma.subscription.update({ where: { id: sub.id }, data: { status: 'PAST_DUE' } });
    expect(await count('SUBSCRIPTION_GRACE_PERIOD')).toBe(1);
  }, 20000);
  it('positive grace already due is captured by the trigger and not duplicated by temporal generation', async () => {
    const sub = await subscription({ currentPeriodEnd: new Date(Date.now() - 1000) });
    await prisma.subscription.update({ where: { id: sub.id }, data: { status: 'PAST_DUE', graceEndsAt: new Date(Date.now() + 86400000) } });
    expect(await count('SUBSCRIPTION_GRACE_PERIOD')).toBe(1);
    expect(await engine().temporal()).toEqual({ inserted: 0 });
  });
  it('preserves legacy txid-keyed evidence and does not redeliver the same paid cycle', async () => {
    const sub = await subscription({ currentPeriodEnd: new Date(Date.now() - 1000) });
    const legacy = await prisma.globalCommunicationOutbox.create({ data: { companyId: company, event: 'SUBSCRIPTION_GRACE_PERIOD', businessKey: `SUBSCRIPTION_GRACE_PERIOD:${sub.id}:123456`, variables: {}, notificationProcessedAt: new Date(), expandedAt: new Date() } });
    await prisma.subscription.update({ where: { id: sub.id }, data: { status: 'PAST_DUE', graceEndsAt: new Date(Date.now() + 86400000) } });
    expect(await engine().temporal()).toEqual({ inserted: 0 }); expect(await count('SUBSCRIPTION_GRACE_PERIOD')).toBe(1);
    expect(await prisma.globalCommunicationOutbox.findUnique({ where: { id: legacy.id } })).toEqual(legacy);
  });
  it('lifecycle cannot expire ACTIVE or suspend PAST_DUE early; suspension is due at the exact deadline and captured once', async () => {
    const sub = await subscription(); const now = new Date();
    await prisma.$transaction(tx => domain.elapsed(tx, sub, now)); expect(await prisma.subscription.findUnique({ where: { id: sub.id } })).toEqual(sub);
    const end = new Date(Date.now() + 86400000); const due = await prisma.subscription.update({ where: { id: sub.id }, data: { status: 'PAST_DUE', currentPeriodEnd: new Date(Date.now() - 1000), graceEndsAt: end } });
    await prisma.$transaction(tx => domain.elapsed(tx, due, new Date(end.getTime() - 1))); expect(await count('SUBSCRIPTION_SUSPENDED')).toBe(0);
    await prisma.$transaction(tx => domain.elapsed(tx, due, end));
    const suspended = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } }); expect(suspended.status).toBe('SUSPENDED'); expect(await count('SUBSCRIPTION_SUSPENDED')).toBe(1);
    await prisma.$transaction(tx => domain.elapsed(tx, suspended, new Date(end.getTime()+1))); expect(await count('SUBSCRIPTION_SUSPENDED')).toBe(1);
    await new LifecycleService(prisma as never, {} as never, {} as never, {} as never).reconcile(); expect(await count('SUBSCRIPTION_SUSPENDED')).toBe(1);
  });
  it('zero grace at paid-period expiry suspends directly without grace; paid proof still permits reactivation', async () => {
    vi.stubEnv('BILLING_GRACE_DAYS', '0');
    const now = new Date(), sub = await subscription({ currentPeriodEnd: now });
    await prisma.$transaction(tx => domain.elapsed(tx, sub, now)); expect(await count('SUBSCRIPTION_GRACE_PERIOD')).toBe(0); expect(await count('SUBSCRIPTION_SUSPENDED')).toBe(1);
    const p = await prisma.payment.create({ data: { companyId: company, subscriptionId: sub.id, planId: plan, status: 'APPROVED', gateway: 'STRIPE', environment: 'SANDBOX', amountCents: 199, periodStart: now, periodEnd: new Date(now.getTime()+30*86400000) } });
    await prisma.$transaction(tx => domain.reactivate(tx, p.id, company));
    expect(await prisma.subscription.findUnique({ where: { id: sub.id } })).toMatchObject({ status: 'ACTIVE' }); expect(await count('SUBSCRIPTION_REACTIVATED')).toBe(1);
  });
  it('ACTIVE and PENDING never generate grace, and commercial temporal generation excludes QA windows', async () => {
    await subscription(); await subscription({ status: 'PENDING' });
    const qa = await subscription({ gateway: 'QA_SIMULATION', currentPeriodEnd: new Date(Date.now()+10000) });
    await prisma.subscription.update({ where: { id: qa.id }, data: { status: 'PAST_DUE', graceEndsAt: new Date(Date.now()+86400000) } });
    expect(await engine().temporal()).toEqual({ inserted: 0 }); expect(await count('SUBSCRIPTION_GRACE_PERIOD')).toBe(0);
  });
});
