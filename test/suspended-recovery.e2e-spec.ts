import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { PaymentsService } from '../src/billing/payments.service.js';
import { WebhookProcessor } from '../src/billing/webhook-processor.service.js';
import { EntitlementsService } from '../src/billing/entitlements.service.js';
import { QaSimulationService } from '../src/billing/qa-simulation.service.js';
import { createQaLifecycleFixture } from '../src/billing/qa-lifecycle-fixture.js';
import { BillingDomain } from '../src/billing/billing-domain.js';

describe('suspended subscription recovery with persisted commercial facts', () => {
  let pg: PGlite, socket: PGLiteSocketServer, db: PrismaClient;
  let companyId: string, planId: string, subscriptionId: string;
  const charge = vi.fn(),
    recurring = vi.fn();
  const registry = {
    get: () => ({ createCharge: charge, createSubscription: recurring }),
  };
  const gateways = { context: async () => ({ environment: 'SANDBOX' }) };
  const payments = () =>
    new PaymentsService(db as never, registry as never, gateways as never);
  const qa = () => new QaSimulationService(db as never);
  const input = () => ({
    planId,
    gateway: 'STRIPE',
    billingInterval: 'MONTHLY',
    idempotencyKey: randomUUID(),
  });
  beforeAll(async () => {
    pg = new PGlite();
    const root = new URL('../prisma/migrations/', import.meta.url);
    for (const name of (await readdir(root)).sort())
      if (name !== 'migration_lock.toml')
        await pg.exec(
          await readFile(new URL(`${name}/migration.sql`, root), 'utf8'),
        );
    socket = new PGLiteSocketServer({ db: pg, host: '127.0.0.1', port: 0 });
    await socket.start();
    db = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: `postgresql://test:test@${socket.getServerConn()}/test`,
        max: 1,
      }),
    });
  });
  afterAll(async () => {
    await db.$disconnect();
    await socket.stop();
    await pg.close();
  });
  beforeEach(async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('EXTERNAL_NETWORK_FORBIDDEN');
      }),
    );
    vi.stubEnv('DATABASE_URL', 'postgresql://test:test@localhost/kalend_dev');
    vi.stubEnv('EVOLUTION_WEBHOOK_BASE_URL', 'https://api-dev.kalend.tech');
    vi.stubEnv('BILLING_PUBLIC_API_URL', 'https://api-dev.kalend.tech');
    vi.stubEnv('COMMERCIAL_QA_SIMULATION_ENABLED', 'true');
    vi.stubEnv('QA_COMMUNICATION_ENABLED', 'true');
    vi.stubEnv('QA_COMMUNICATION_EMAIL_ALLOWLIST', 'qa@example.test');
    vi.stubEnv('QA_COMMUNICATION_PHONE_ALLOWLIST', '5511999999999');
    vi.stubEnv('BILLING_GRACE_DAYS', '0');
    const company = await db.company.create({
      data: {
        name: 'QA recovery',
        slug: randomUUID(),
        status: 'SUSPENDED',
        isActive: false,
      },
    });
    companyId = company.id;
    vi.stubEnv('QA_COMMUNICATION_COMPANY_IDS', companyId);
    const owner = await db.user.create({
      data: {
        name: 'QA',
        email: `${randomUUID()}@example.test`,
        phone: '5511999999999',
        passwordHash: 'test-only',
      },
    });
    await db.membership.create({
      data: { companyId, userId: owner.id, role: 'OWNER' },
    });
    const plan = await db.plan.create({
      data: {
        code: randomUUID(),
        name: 'Plan',
        monthlyPriceCents: 199,
        isPublic: true,
      },
    });
    planId = plan.id;
    subscriptionId = (
      await db.subscription.create({
        data: {
          companyId,
          planId,
          status: 'SUSPENDED',
          gateway: 'STRIPE',
          environment: 'SANDBOX',
          externalSubscriptionId: randomUUID(),
        },
      })
    ).id;
    charge.mockReset().mockResolvedValue({
      externalPaymentId: randomUUID(),
      checkoutUrl: 'https://example.test/mock',
    });
    recurring
      .mockReset()
      .mockRejectedValue(new Error('DUPLICATE_RECURRENCE_FORBIDDEN'));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  async function approve(paymentId: string, eventId = randomUUID()) {
    const payment = await db.payment.findUniqueOrThrow({
      where: { id: paymentId },
    });
    return new WebhookProcessor(
      db as never,
      registry as never,
      gateways as never,
    ).processVerified('STRIPE', {
      eventId,
      environment: 'SANDBOX',
      type: 'PAYMENT_APPROVED',
      status: 'APPROVED',
      externalPaymentId: payment.externalPaymentId!,
      externalReference: payment.id,
      amountCents: payment.amountCents,
      currency: 'BRL',
    });
  }
  it.each(['SUSPENDED', 'PAST_DUE'] as const)(
    'checkout reuses %s, webhook reactivates once, and duplicate checkout/event do not duplicate work',
    async (status) => {
      await db.subscription.update({
        where: { id: subscriptionId },
        data: { status },
      });
      const body = input();
      await expect(
        new EntitlementsService(db as never).current(companyId),
      ).rejects.toThrow();
      const payment = await payments().checkout(companyId, body);
      expect(payment.subscriptionId).toBe(subscriptionId);
      expect(await db.subscription.count({ where: { companyId } })).toBe(1);
      expect((await payments().checkout(companyId, body)).id).toBe(payment.id);
      expect(charge).toHaveBeenCalledTimes(1);
      expect(recurring).not.toHaveBeenCalled();
      const eventId = randomUUID();
      await approve(payment.id, eventId);
      await approve(payment.id, eventId);
      expect(
        await db.subscription.findUnique({ where: { id: subscriptionId } }),
      ).toMatchObject({ status: 'ACTIVE' });
      expect(
        await db.company.findUnique({ where: { id: companyId } }),
      ).toMatchObject({
        administrativeStatus: 'ACTIVE',
        status: 'ACTIVE',
        isActive: true,
      });
      expect(
        (await new EntitlementsService(db as never).current(companyId)).id,
      ).toBe(subscriptionId);
      expect(
        await db.globalCommunicationOutbox.count({
          where: { companyId, event: 'SUBSCRIPTION_REACTIVATED' },
        }),
      ).toBe(1);
      expect(await db.payment.count({ where: { companyId } })).toBe(1);
    },
  );
  it.each(['DISABLED', 'LEGACY_UNKNOWN'] as const)(
    '%s blocks checkout and access; a genuine approval is recorded without restoring the subscription or company',
    async (administrativeStatus) => {
      const p = await payments().checkout(companyId, input());
      await db.company.update({
        where: { id: companyId },
        data: { administrativeStatus },
      });
      await expect(payments().checkout(companyId, input())).rejects.toThrow(
        'COMPANY_ADMINISTRATIVELY_BLOCKED',
      );
      await approve(p.id);
      expect(
        await db.payment.findUnique({ where: { id: p.id } }),
      ).toMatchObject({ status: 'APPROVED' });
      expect(
        await db.subscription.findUnique({ where: { id: subscriptionId } }),
      ).toMatchObject({ status: 'SUSPENDED' });
      expect(
        await db.company.findUnique({ where: { id: companyId } }),
      ).toMatchObject({
        administrativeStatus,
        status: 'SUSPENDED',
        isActive: false,
      });
      await expect(
        new EntitlementsService(db as never).current(companyId),
      ).rejects.toThrow();
      expect(
        await db.globalCommunicationOutbox.count({
          where: { companyId, event: 'SUBSCRIPTION_REACTIVATED' },
        }),
      ).toBe(0);
    },
  );
  it('rejects incompatible plan, interval, provider/environment, identity injection and duplicate recurring enrollment before provider mutation', async () => {
    for (const mismatch of [
      { planId: randomUUID() },
      { billingInterval: 'YEARLY' },
      { gateway: 'PAGBANK' },
      { recurring: true },
      { subscriptionId: randomUUID() },
    ])
      await expect(
        payments().checkout(companyId, { ...input(), ...mismatch }),
      ).rejects.toThrow();
    await db.subscription.update({
      where: { id: subscriptionId },
      data: { environment: 'PRODUCTION' },
    });
    await expect(payments().checkout(companyId, input())).rejects.toThrow(
      'RECOVERY_SUBSCRIPTION_TERMS_MISMATCH',
    );
    expect(charge).not.toHaveBeenCalled();
    expect(recurring).not.toHaveBeenCalled();
  });
  it.each(['STRIPE', 'PAGBANK', 'MERCADO_PAGO', 'ASAAS'] as const)(
    '%s recovery never creates another recurring mandate',
    async (gateway) => {
      await db.subscription.update({
        where: { id: subscriptionId },
        data: { gateway },
      });
      const payment = await payments().checkout(companyId, {
        ...input(),
        gateway,
        ...(gateway === 'ASAAS' ? { taxId: '12345678901' } : {}),
      });
      expect(payment.subscriptionId).toBe(subscriptionId);
      expect(charge).toHaveBeenCalledTimes(1);
      expect(recurring).not.toHaveBeenCalled();
    },
  );
  it('canceled external subscription is never reused as a recovery target', async () => {
    await db.subscription.update({
      where: { id: subscriptionId },
      data: { status: 'CANCELED' },
    });
    const p = await payments().checkout(companyId, input());
    expect(p.subscriptionId).not.toBe(subscriptionId);
    expect(
      await db.subscription.findUnique({ where: { id: subscriptionId } }),
    ).toMatchObject({ status: 'CANCELED' });
  });
  it('QA recovery on a suspended company reuses its own subscription and approved automatically emits reactivation', async () => {
    await db.subscription.update({
      where: { id: subscriptionId },
      data: { gateway: 'QA_SIMULATION' },
    });
    expect(await qa().preflightFromCli(companyId)).toMatchObject({
      companyActive: false,
      companyStatus: 'SUSPENDED',
      administrativeStatus: 'ACTIVE',
      recoveryOnly: true,
      safeToSimulate: true,
    });
    const pending = await qa().simulateFromCli({
      companyId,
      action: 'PAYMENT_PENDING',
      subscriptionId,
      idempotencyKey: 'recovery',
    });
    expect(pending.subscriptionId).toBe(subscriptionId);
    await expect(
      qa().simulateFromCli({
        companyId,
        action: 'SUBSCRIPTION_SUSPENDED',
        paymentId: pending.paymentId,
      }),
    ).rejects.toThrow('QA_COMPANY_RECOVERY_ONLY');
    await qa().simulateFromCli({
      companyId,
      action: 'PAYMENT_APPROVED',
      paymentId: pending.paymentId,
    });
    expect(await db.subscription.count({ where: { companyId } })).toBe(1);
    expect(
      await db.subscription.findUnique({ where: { id: subscriptionId } }),
    ).toMatchObject({ status: 'ACTIVE' });
    expect(
      await db.globalCommunicationOutbox.count({
        where: {
          companyId,
          event: 'SUBSCRIPTION_REACTIVATED',
          businessKey: { startsWith: 'QA_SIMULATION:' },
        },
      }),
    ).toBe(1);
    expect(charge).not.toHaveBeenCalled();
    expect(recurring).not.toHaveBeenCalled();
  });
  it('QA tenant isolation, administrative quarantine and PROD guards apply to recovery', async () => {
    await db.subscription.update({
      where: { id: subscriptionId },
      data: { gateway: 'QA_SIMULATION' },
    });
    await expect(
      qa().simulateFromCli({
        companyId,
        action: 'PAYMENT_PENDING',
        subscriptionId: randomUUID(),
        idempotencyKey: 'wrong-tenant',
      }),
    ).rejects.toThrow();
    const other = await db.company.create({
      data: { name: 'Other tenant', slug: randomUUID() },
    });
    const foreign = await db.subscription.create({
      data: {
        companyId: other.id,
        planId,
        status: 'SUSPENDED',
        gateway: 'QA_SIMULATION',
        environment: 'SANDBOX',
      },
    });
    await expect(
      qa().simulateFromCli({
        companyId,
        action: 'PAYMENT_PENDING',
        subscriptionId: foreign.id,
        idempotencyKey: 'foreign',
      }),
    ).rejects.toThrow('QA_SUBSCRIPTION_SCOPE_MISMATCH');
    expect(
      await db.subscription.findUnique({ where: { id: foreign.id } }),
    ).toEqual(foreign);
    for (const administrativeStatus of [
      'DISABLED',
      'LEGACY_UNKNOWN',
    ] as const) {
      await db.company.update({
        where: { id: companyId },
        data: { administrativeStatus },
      });
      await expect(qa().preflightFromCli(companyId)).rejects.toThrow();
    }
    vi.stubEnv('DATABASE_URL', 'postgresql://test:test@localhost/kalend');
    vi.stubEnv('EVOLUTION_WEBHOOK_BASE_URL', 'https://api.kalend.tech');
    await expect(qa().preflightFromCli(companyId)).rejects.toThrow();
    await expect(
      createQaLifecycleFixture(db as never, companyId, 'prod'),
    ).rejects.toThrow();
  });
  it('fixture reuses an allowlisted OWNER and creates no subscription, user or Evolution; requires separate company authorization', async () => {
    const owner = await db.membership.findFirstOrThrow({
      where: { companyId, role: 'OWNER' },
    });
    const user = await db.user.findUniqueOrThrow({
      where: { id: owner.userId },
    });
    vi.stubEnv('QA_COMMUNICATION_EMAIL_ALLOWLIST', user.email);
    const users = await db.user.count();
    const fixture = await createQaLifecycleFixture(
      db as never,
      companyId,
      'fixture',
    );
    expect(
      await db.subscription.count({ where: { companyId: fixture.companyId } }),
    ).toBe(0);
    expect(
      await db.evolutionConnection.count({
        where: { companyId: fixture.companyId },
      }),
    ).toBe(0);
    expect(await db.user.count()).toBe(users);
    expect(
      await db.membership.findFirst({
        where: { companyId: fixture.companyId },
      }),
    ).toMatchObject({ userId: owner.userId, role: 'OWNER' });
    expect(
      (await createQaLifecycleFixture(db as never, companyId, 'fixture'))
        .companyId,
    ).toBe(fixture.companyId);
    await expect(qa().preflightFromCli(fixture.companyId)).rejects.toThrow();
    vi.stubEnv('QA_COMMUNICATION_EMAIL_ALLOWLIST', 'different@example.test');
    await expect(
      createQaLifecycleFixture(db as never, companyId, 'blocked'),
    ).rejects.toThrow();
  });
  it('grace override is domain-local and cannot extend another company or change global configuration', async () => {
    await db.company.update({
      where: { id: companyId },
      data: { status: 'ACTIVE', isActive: true },
    });
    await db.subscription.update({
      where: { id: subscriptionId },
      data: { gateway: 'QA_SIMULATION', status: 'PAST_DUE' },
    });
    const p = await qa().simulateFromCli({
      companyId,
      action: 'PAYMENT_PENDING',
      subscriptionId,
      idempotencyKey: 'grace',
    });
    await qa().simulateFromCli({
      companyId,
      action: 'SUBSCRIPTION_GRACE_PERIOD',
      paymentId: p.paymentId,
      graceDays: 1,
    });
    const sub = await db.subscription.findUniqueOrThrow({
      where: { id: subscriptionId },
    });
    expect(sub.graceEndsAt!.getTime() - sub.currentPeriodEnd!.getTime()).toBe(
      86400000,
    );
    expect(process.env.BILLING_GRACE_DAYS).toBe('0');
    const original = await db.company.create({
      data: { name: 'Other', slug: randomUUID() },
    });
    const untouched = await db.subscription.create({
      data: {
        companyId: original.id,
        planId,
        status: 'ACTIVE',
        currentPeriodEnd: new Date(),
      },
    });
    await db.$transaction((tx) =>
      new BillingDomain().elapsed(tx, untouched, new Date()),
    );
    expect(
      await db.subscription.findUnique({ where: { id: untouched.id } }),
    ).toMatchObject({
      status: 'SUSPENDED',
      graceEndsAt: untouched.currentPeriodEnd,
    });
    expect(
      await db.globalCommunicationOutbox.count({
        where: { companyId, event: 'SUBSCRIPTION_GRACE_PERIOD' },
      }),
    ).toBe(1);
  });
});
