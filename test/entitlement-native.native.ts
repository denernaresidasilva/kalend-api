import { nativeTarget } from './support/native-postgres.js';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { WebhookProcessor } from '../src/billing/webhook-processor.service.js';
import { createAdminGrant } from '../src/billing/admin-grant.js';
import { entitledWhere } from '../src/billing/commercial-policy.js';
import { nextPeriod } from '../src/common/period.js';

const { connectionString: url, directory } = nativeTarget();
const pool = new Pool({ connectionString: url, max: 6 });
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: url, max: 6 }),
});
const processor = new WebhookProcessor(db as never, {} as never, {} as never);
let companyId: string, planId: string, adminId: string;
const start = new Date(Date.now() - 1000);
const end = nextPeriod(start, 'MONTHLY');
async function payment(subscriptionId?: string, from = start) {
  const sub = subscriptionId
    ? { id: subscriptionId }
    : await db.subscription.create({
        data: {
          companyId,
          planId,
          gateway: 'STRIPE',
          environment: 'SANDBOX',
          status: 'PENDING',
        },
      });
  return db.payment.create({
    data: {
      companyId,
      planId,
      subscriptionId: sub.id,
      gateway: 'STRIPE',
      environment: 'SANDBOX',
      status: 'PENDING',
      amountCents: 199,
      periodStart: from,
      periodEnd: nextPeriod(from, 'MONTHLY'),
      externalPaymentId: randomUUID(),
      creationState: 'CREATED',
    },
  });
}
type Payment = Awaited<ReturnType<typeof payment>>;
function event(
  p: Payment,
  status: 'APPROVED' | 'REFUNDED' | 'OVERDUE' | 'FAILED',
  id = `${p.id}:${status}`,
  refundedAmountCents?: number,
) {
  return processor.processVerified('STRIPE', {
    eventId: id,
    type: status,
    status,
    externalPaymentId: p.externalPaymentId!,
    externalReference: p.id,
    environment: 'SANDBOX',
    amountCents: 199,
    currency: 'BRL',
    ...(refundedAmountCents === undefined
      ? {}
      : { refundedAmountCents, externalRefundId: id }),
  });
}
const access = () =>
  db.subscription.count({ where: entitledWhere(companyId, new Date()) });
beforeAll(async () => {
  const { rows } = await pool.query('SHOW data_directory');
  if (rows[0].data_directory !== directory) throw Error('WRONG_CLUSTER');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  const version = await pool.query('SELECT version()');
  console.log('NATIVE_VERSION', version.rows[0].version);
  for (const name of (await readdir('prisma/migrations')).sort())
    if (name !== 'migration_lock.toml')
      await pool.query(
        await readFile(`prisma/migrations/${name}/migration.sql`, 'utf8'),
      );
}, 120000);
beforeEach(async () => {
  await pool.query('TRUNCATE "Company", "User", "Plan" CASCADE');
  companyId = (
    await db.company.create({
      data: { name: 'Native QA', slug: randomUUID(), status: 'ACTIVE' },
    })
  ).id;
  planId = (
    await db.plan.create({
      data: { name: 'QA', code: randomUUID(), monthlyPriceCents: 199 },
    })
  ).id;
  adminId = (
    await db.user.create({
      data: {
        name: 'QA',
        email: `${randomUUID()}@example.test`,
        passwordHash: 'unused',
        isSuperAdmin: true,
      },
    })
  ).id;
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('EXTERNAL_NETWORK_FORBIDDEN');
    }),
  );
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  await db.$disconnect();
  await pool.end();
});

it('proves independent native backends and an overlapping FOR UPDATE lock wait', async () => {
  const p = await payment();
  const a = await pool.connect();
  const b = await pool.connect();
  try {
    const pa = (await a.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    const pb = (await b.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    expect(pa).not.toBe(pb);
    await a.query('BEGIN');
    await b.query('BEGIN');
    await a.query('SELECT id FROM "Subscription" WHERE id=$1 FOR UPDATE', [
      p.subscriptionId,
    ]);
    const waiting = b.query(
      'SELECT id FROM "Subscription" WHERE id=$1 FOR UPDATE',
      [p.subscriptionId],
    );
    let blocked = false;
    for (let i = 0; i < 100; i++) {
      const state = await pool.query('SELECT pg_blocking_pids($1) blockers', [
        pb,
      ]);
      if (state.rows[0].blockers.includes(pa)) {
        blocked = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(blocked).toBe(true);
    await writeFile(`${directory}/lock-evidence.json`, JSON.stringify({ backendPids: [pa, pb], blocked, poolMax: 6 }));
    console.log('LOCK_BACKENDS', { pa, pb, blocked });
    await a.query('COMMIT');
    await waiting;
    await b.query('COMMIT');
  } finally {
    await a.query('ROLLBACK');
    await b.query('ROLLBACK');
    a.release();
    b.release();
  }
});
it('duplicate concurrent webhook claims commit one payment proof and one communication event', async () => {
  const p = await payment();
  await Promise.all([event(p, 'APPROVED'), event(p, 'APPROVED')]);
  expect(await db.webhookEvent.count({ where: { status: 'PROCESSED' } })).toBe(
    1,
  );
  expect(await db.paymentEvidence.count()).toBe(1);
  expect(await db.subscriptionEntitlement.count()).toBe(1);
  expect(
    await db.globalCommunicationOutbox.count({
      where: { event: 'PAYMENT_APPROVED' },
    }),
  ).toBe(1);
});
it('different simultaneous approvals for the same payment remain idempotent', async () => {
  const p = await payment();
  await Promise.all([event(p, 'APPROVED', 'a'), event(p, 'APPROVED', 'b')]);
  expect(await db.paymentEvidence.count()).toBe(1);
  expect(await db.subscriptionEntitlement.count()).toBe(1);
});
it('two paid proofs of the same interval never multiply access periods', async () => {
  const p = await payment();
  const q = await payment(p.subscriptionId!);
  await Promise.all([event(p, 'APPROVED'), event(q, 'APPROVED')]);
  expect(await db.subscriptionEntitlement.count()).toBe(1);
  expect(await db.paymentEvidence.count()).toBe(2);
  expect(
    await db.paymentEvidence.count({
      where: { financialReviewRequired: true },
    }),
  ).toBeGreaterThan(0);
  expect(
    (
      await db.subscription.findUniqueOrThrow({
        where: { id: p.subscriptionId! },
      })
    ).currentPeriodEnd,
  ).toEqual(end);
});
it('concurrent adjacent renewals preserve the furthest legitimate boundary', async () => {
  const p = await payment();
  const q = await payment(p.subscriptionId!, end);
  await Promise.all([event(p, 'APPROVED'), event(q, 'APPROVED')]);
  expect(await db.subscriptionEntitlement.count()).toBe(2);
  expect(
    (
      await db.subscription.findUniqueOrThrow({
        where: { id: p.subscriptionId! },
      })
    ).currentPeriodEnd,
  ).toEqual(q.periodEnd);
});
it('overlapping payments retain union coverage and flag finance review', async () => {
  const p = await payment();
  const q = await payment(
    p.subscriptionId!,
    new Date(start.getTime() + 86400000),
  );
  await Promise.all([event(p, 'APPROVED'), event(q, 'APPROVED')]);
  expect(await access()).toBe(1);
  expect(
    await db.paymentEvidence.count({
      where: { financialReviewRequired: true },
    }),
  ).toBeGreaterThan(0);
});
it('concurrent refunds of alternative proofs remove paid access without deleting history', async () => {
  const p = await payment();
  const q = await payment(p.subscriptionId!);
  await event(p, 'APPROVED');
  await event(q, 'APPROVED');
  await Promise.all([event(p, 'REFUNDED'), event(q, 'REFUNDED')]);
  expect(await access()).toBe(0);
  expect(await db.payment.count()).toBe(2);
});
it('partial refund concurrent with a second approval preserves only valid coverage', async () => {
  const p = await payment();
  const q = await payment(p.subscriptionId!);
  await event(p, 'APPROVED');
  await Promise.all([
    event(p, 'REFUNDED', 'partial', 50),
    event(q, 'APPROVED'),
  ]);
  expect(await access()).toBe(1);
  expect(
    await db.paymentEvidence.count({
      where: { financialReviewRequired: true },
    }),
  ).toBeGreaterThan(0);
});
it.each(['FAILED', 'OVERDUE'] as const)(
  'never-paid %s does not gain grace',
  async (status) => {
    const p = await payment();
    await event(p, status);
    expect(await access()).toBe(0);
    expect(await db.subscriptionEntitlement.count()).toBe(0);
  },
);
it('administrative grant creation and payment reversal retain only the explicit grant', async () => {
  const p = await payment();
  await event(p, 'APPROVED');
  const [grant] = await Promise.all([
    db.$transaction((tx) =>
      createAdminGrant(tx, adminId, p.subscriptionId!, start, end),
    ),
    event(p, 'REFUNDED'),
  ]);
  expect(await access()).toBe(1);
  await db.subscriptionEntitlement.update({
    where: { id: grant.id },
    data: { revokedAt: new Date(), revokedById: adminId },
  });
  expect(await access()).toBe(0);
});
it('replayed approval after chargeback cannot create a second entitlement', async () => {
  const p = await payment();
  await event(p, 'APPROVED');
  await event(p, 'REFUNDED');
  await event(p, 'APPROVED');
  expect(await access()).toBe(0);
  expect(await db.subscriptionEntitlement.count()).toBe(1);
});
it('duplicate concurrent grant revocations remain successful and preserve the actor', async () => {
  const p = await payment();
  const grant = await db.$transaction((tx) =>
    createAdminGrant(tx, adminId, p.subscriptionId!, start, end),
  );
  const { CompaniesService } =
    await import('../src/companies/companies.service.js');
  const companies = new CompaniesService(db as never);
  await Promise.all([
    companies.revokeAdministrativeGrant(companyId, grant.id, adminId),
    companies.revokeAdministrativeGrant(companyId, grant.id, adminId),
  ]);
  const revoked = await db.subscriptionEntitlement.findUniqueOrThrow({
    where: { id: grant.id },
  });
  expect(revoked.revokedById).toBe(adminId);
  expect(revoked.revokedAt).not.toBeNull();
  expect(await access()).toBe(0);
});
it('grant revocation racing a legitimate approval preserves the paid right', async () => {
  const p = await payment();
  const grant = await db.$transaction((tx) =>
    createAdminGrant(tx, adminId, p.subscriptionId!, start, end),
  );
  const { CompaniesService } =
    await import('../src/companies/companies.service.js');
  await Promise.all([
    new CompaniesService(db as never).revokeAdministrativeGrant(
      companyId,
      grant.id,
      adminId,
    ),
    event(p, 'APPROVED'),
  ]);
  expect(await access()).toBe(1);
  expect(await db.paymentEvidence.count({ where: { status: 'APPLIED' } })).toBe(
    1,
  );
});
it('a new payment after full refund recovers the same right without duplicating periods', async () => {
  const p = await payment();
  await event(p, 'APPROVED');
  await event(p, 'REFUNDED');
  expect(await access()).toBe(0);
  const q = await payment(p.subscriptionId!);
  await Promise.all([
    event(q, 'APPROVED', 'recovery-a'),
    event(q, 'APPROVED', 'recovery-b'),
  ]);
  expect(await access()).toBe(1);
  expect(await db.subscriptionEntitlement.count()).toBe(1);
  expect(await db.paymentEvidence.count()).toBe(2);
});
it('approval racing full refund of the same payment cannot resurrect refunded access', async () => {
  const p = await payment();
  await event(p, 'APPROVED');
  await Promise.all([
    event(p, 'APPROVED', 'late-approval'),
    event(p, 'REFUNDED'),
  ]);
  expect(await access()).toBe(0);
  expect(
    (await db.payment.findUniqueOrThrow({ where: { id: p.id } })).status,
  ).toBe('REFUNDED');
});
