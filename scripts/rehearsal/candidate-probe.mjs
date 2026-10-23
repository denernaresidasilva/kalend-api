// Candidate services only: no Nest bootstrap, workers, provider requests or HTTP listener.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { WebhookProcessor } from './dist/billing/webhook-processor.service.js';
import {
  entitledWhere,
  eligibleGrace,
} from './dist/billing/commercial-policy.js';
import { nextPeriod } from './dist/common/period.js';
import { createAdminGrant } from './dist/billing/admin-grant.js';
import { CompaniesService } from './dist/companies/companies.service.js';
const url = new URL(process.env.DATABASE_URL);
assert.equal(url.pathname, '/kalend_rehearsal_qa');
assert.equal(url.searchParams.get('host'), '/work');
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: url.toString(), max: 6 }),
});
const forbidden = new Proxy(
  {},
  {
    get() {
      throw Error('EXTERNAL_PROVIDER_FORBIDDEN');
    },
  },
);
const processor = new WebhookProcessor(db, forbidden, forbidden);
const report = {
  candidateServicesUsed: true,
  prismaCrud: true,
  noAppBootstrap: true,
  noWorkers: true,
  providerCalls: 0,
  tests: [],
};
const record = (name) => report.tests.push({ name, passed: true });
const now = new Date();
const start = new Date(now.getTime() - 1000);
const end = nextPeriod(start, 'MONTHLY');
async function fixture(from = start, to = end) {
  const company = await db.company.create({
    data: {
      name: 'Isolated rehearsal fixture',
      slug: randomUUID(),
      status: 'ACTIVE',
    },
  });
  const plan = await db.plan.create({
    data: { name: 'Isolated plan', code: randomUUID(), monthlyPriceCents: 199 },
  });
  const admin = await db.user.create({
    data: {
      name: 'Synthetic admin',
      email: `${randomUUID()}@example.test`,
      passwordHash: 'INERT_TEST_ONLY',
      isSuperAdmin: true,
    },
  });
  const sub = await db.subscription.create({
    data: {
      companyId: company.id,
      planId: plan.id,
      gateway: 'STRIPE',
      environment: 'SANDBOX',
      status: 'PENDING',
    },
  });
  const payment = () =>
    db.payment.create({
      data: {
        companyId: company.id,
        planId: plan.id,
        subscriptionId: sub.id,
        gateway: 'STRIPE',
        environment: 'SANDBOX',
        status: 'PENDING',
        amountCents: 199,
        periodStart: from,
        periodEnd: to,
        externalPaymentId: randomUUID(),
        creationState: 'CREATED',
      },
    });
  const access = () =>
    db.subscription.count({ where: entitledWhere(company.id) });
  return { company, plan, admin, sub, payment, access };
}
async function event(p, status, id = randomUUID(), refund, type = status) {
  return processor.processVerified('STRIPE', {
    eventId: id,
    type,
    status,
    externalPaymentId: p.externalPaymentId,
    externalReference: p.id,
    environment: 'SANDBOX',
    amountCents: 199,
    currency: 'BRL',
    ...(refund === undefined
      ? {}
      : { refundedAmountCents: refund, externalRefundId: id }),
  });
}
try {
  assert.equal(await db.paymentEvidence.count(), 1);
  assert.equal(await db.subscriptionEntitlement.count(), 1);
  assert.equal(
    await db.subscriptionEntitlement.count({
      where: { origin: 'ADMIN_GRANT' },
    }),
    0,
  );
  const originals = await db.subscription.findMany({
    select: {
      id: true,
      companyId: true,
      status: true,
      currentPeriodStart: true,
      currentPeriodEnd: true,
      company: { select: { administrativeStatus: true } },
      entitlements: { select: { id: true } },
    },
  });
  let unentitled = 0;
  for (const s of originals) {
    if (!s.entitlements.length) {
      unentitled++;
      if (s.status !== 'TRIALING')
        assert.equal(
          await db.subscription.count({
            where: { AND: [{ id: s.id }, entitledWhere(s.companyId)] },
          }),
          0,
        );
    } else {
      const at = new Date(
        (s.currentPeriodStart.getTime() + s.currentPeriodEnd.getTime()) / 2,
      );
      const expected =
        s.company.administrativeStatus === 'ACTIVE' &&
        ['ACTIVE', 'PAST_DUE'].includes(s.status)
          ? 1
          : 0;
      assert.equal(
        await db.subscription.count({
          where: { AND: [{ id: s.id }, entitledWhere(s.companyId, at)] },
        }),
        expected,
      );
    }
  }
  assert.equal(unentitled, 6);
  record(
    'real_backfill_candidate_policy_1_paid_6_without_paid_right_trial_not_misclassified',
  );
  for (const status of ['FAILED', 'OVERDUE']) {
    const f = await fixture();
    const p = await f.payment();
    await event(p, status);
    assert.equal(await f.access(), 0);
    assert.equal(
      await db.subscriptionEntitlement.count({
        where: { subscriptionId: f.sub.id },
      }),
      0,
    );
    const sub = await db.subscription.findUniqueOrThrow({
      where: { id: f.sub.id },
    });
    assert.equal(
      await db.$transaction((tx) => eligibleGrace(tx, sub, now, 7)),
      null,
    );
    record(`initial_${status}_cannot_grant_grace_or_access`);
  }
  {
    const f = await fixture();
    const p = await f.payment();
    const id = randomUUID();
    await Promise.all([event(p, 'APPROVED', id), event(p, 'APPROVED', id)]);
    assert.equal(await f.access(), 1);
    assert.equal(
      await db.paymentEvidence.count({ where: { subscriptionId: f.sub.id } }),
      1,
    );
    const q = await f.payment();
    await Promise.all([event(q, 'APPROVED'), event(q, 'APPROVED')]);
    assert.equal(
      await db.subscriptionEntitlement.count({
        where: { subscriptionId: f.sub.id },
      }),
      1,
    );
    assert.equal(
      await db.paymentEvidence.count({ where: { subscriptionId: f.sub.id } }),
      2,
    );
    assert.equal(await f.access(), 1);
    record(
      'concurrent_duplicate_webhooks_and_overlapping_proofs_do_not_multiply_periods',
    );
    const other = await fixture();
    assert.equal(
      await db.paymentEvidence.count({
        where: { companyId: other.company.id, subscriptionId: f.sub.id },
      }),
      0,
    );
    await assert.rejects(
      db.paymentEvidence.updateMany({
        where: { paymentId: p.id },
        data: { companyId: other.company.id },
      }),
    );
    record('tenant_cross_scope_evidence_mutation_rejected');
  }
  {
    const f = await fixture();
    const p = await f.payment();
    await event(p, 'APPROVED');
    await event(p, 'REFUNDED', randomUUID(), 50);
    assert.equal(await f.access(), 1);
    await event(p, 'REFUNDED', randomUUID(), 199);
    assert.equal(await f.access(), 0);
    const q = await f.payment();
    await Promise.all([event(q, 'APPROVED'), event(q, 'APPROVED')]);
    assert.equal(await f.access(), 1);
    assert.equal(
      await db.subscriptionEntitlement.count({
        where: { subscriptionId: f.sub.id },
      }),
      1,
    );
    record(
      'partial_refund_full_refund_suspension_and_new_payment_reactivation',
    );
    await event(q, 'FAILED', randomUUID(), undefined, 'CHARGEBACK');
    assert.equal(await f.access(), 0);
    record('chargeback_removes_remaining_paid_access');
  }
  {
    const f = await fixture();
    const p = await f.payment();
    await event(p, 'APPROVED');
    const [grant] = await Promise.all([
      db.$transaction((tx) =>
        createAdminGrant(tx, f.admin.id, f.sub.id, start, end),
      ),
      event(p, 'REFUNDED'),
    ]);
    assert.equal(await f.access(), 1);
    const service = new CompaniesService(db);
    await Promise.all([
      service.revokeAdministrativeGrant(f.company.id, grant.id, f.admin.id),
      service.revokeAdministrativeGrant(f.company.id, grant.id, f.admin.id),
    ]);
    assert.equal(await f.access(), 0);
    record(
      'explicit_admin_grant_survives_refund_concurrent_revocation_removes_it',
    );
  }
  {
    const f = await fixture();
    const p = await f.payment();
    await event(p, 'APPROVED');
    const sub = await db.subscription.findUniqueOrThrow({
      where: { id: f.sub.id },
    });
    // First establish a paid frontier; then observe one day after its contractual end.
    const observed = new Date(end.getTime() + 86400000);
    const deadline = await db.$transaction((tx) =>
      eligibleGrace(tx, sub, observed, 7),
    );
    assert(deadline > observed);
    await db.subscription.update({
      where: { id: sub.id },
      data: { status: 'PAST_DUE', graceEndsAt: deadline },
    });
    const graceAccess = () =>
      db.subscription.count({ where: entitledWhere(f.company.id, observed) });
    assert.equal(await graceAccess(), 1);
    await db.company.update({
      where: { id: f.company.id },
      data: { administrativeStatus: 'DISABLED' },
    });
    assert.equal(await graceAccess(), 0);
    record('legitimate_paid_grace_and_administrative_block');
  }
  {
    const f = await fixture();
    const p = await f.payment();
    await event(p, 'APPROVED');
    await processor.processVerified('STRIPE', {
      kind: 'subscription',
      eventId: randomUUID(),
      type: 'CANCELED',
      externalSubscriptionId: randomUUID(),
      externalReference: f.sub.id,
      status: 'CANCELED',
      environment: 'SANDBOX',
    });
    assert.equal(await f.access(), 0);
    assert.equal(
      (await db.subscription.findUniqueOrThrow({ where: { id: f.sub.id } }))
        .status,
      'CANCELED',
    );
    record('candidate_verified_cancellation_revokes_access');
  }
  // Verify row-lock overlap with distinct native backend sessions; no provider/worker.
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: url.toString(), max: 3 });
  const a = await pool.connect(),
    b = await pool.connect();
  try {
    const pa = (await a.query('SELECT pg_backend_pid() pid')).rows[0].pid,
      pb = (await b.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    assert.notEqual(pa, pb);
    await a.query('BEGIN');
    await b.query('BEGIN');
    await a.query(
      'SELECT id FROM "Subscription" ORDER BY id LIMIT 1 FOR UPDATE',
    );
    const waiting = b.query(
      'SELECT id FROM "Subscription" ORDER BY id LIMIT 1 FOR UPDATE',
    );
    let observed = false;
    for (let i = 0; i < 100; i++) {
      if (
        (
          await pool.query('SELECT pg_blocking_pids($1) p', [pb])
        ).rows[0].p.includes(pa)
      ) {
        observed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    assert(observed);
    await a.query('ROLLBACK');
    await waiting;
    await b.query('ROLLBACK');
    report.nativeBackendPids = [pa, pb];
    record('independent_native_backends_with_observed_for_update_wait');
  } finally {
    a.release();
    b.release();
    await pool.end();
  }
  writeFileSync(
    '/work/candidate-probe.sanitized.json',
    JSON.stringify(report, null, 2) + '\n',
  );
} finally {
  await db.$disconnect();
}
