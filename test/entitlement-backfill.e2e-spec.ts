import { nativeLegacyDatabase } from './support/native-postgres.js';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const name = '20261017090000_subscription_entitlement_evidence';
const root = new URL('../prisma/migrations/', import.meta.url);
const migrationSql = () =>
  readFile(new URL(`${name}/migration.sql`, root), 'utf8');

async function legacyDatabase() {
  const pg = process.env.KALEND_NATIVE_PG_URL
    ? await nativeLegacyDatabase() as unknown as PGlite
    : new PGlite();
  await pg.exec(`SET TIME ZONE 'UTC'`);
  for (const migration of (await readdir(root)).sort())
    if (migration !== 'migration_lock.toml' && migration < name)
      await pg.exec(
        await readFile(new URL(`${migration}/migration.sql`, root), 'utf8'),
      );
  return pg;
}

async function fixture(
  pg: PGlite,
  options: {
    gateway?: string;
    status?: string;
    start?: Date | null;
    end?: Date | null;
    graceEnd?: Date | null;
  } = {},
) {
  const company = randomUUID();
  const plan = randomUUID();
  const sub = randomUUID();
  const now = Date.now();
  const start =
    options.start === undefined ? new Date(now - 86400000) : options.start;
  const end =
    options.end === undefined ? new Date(now + 86400000) : options.end;
  await pg.query(
    `INSERT INTO "Company"(id,name,slug,status,"updatedAt") VALUES ($1::uuid,'Legacy fixture',$1::text,'ACTIVE',now())`,
    [company],
  );
  await pg.query(
    `INSERT INTO "Plan"(id,name,code,"monthlyPriceCents","updatedAt") VALUES ($1::uuid,'Plan',$1::text,199,now())`,
    [plan],
  );
  await pg.query(
    `INSERT INTO "Subscription"(id,"companyId","planId",status,gateway,"currentPeriodStart","currentPeriodEnd","graceEndsAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())`,
    [
      sub,
      company,
      plan,
      options.status ?? 'ACTIVE',
      options.gateway ?? 'MANUAL',
      start,
      end,
      options.graceEnd ?? null,
    ],
  );
  return { company, plan, sub, start, end };
}

async function approvedPayment(
  pg: PGlite,
  input: {
    sub: string;
    company: string;
    plan: string;
    start: Date;
    end: Date;
    refundedAmountCents?: number;
  },
) {
  const id = randomUUID();
  await pg.query(
    `INSERT INTO "Payment"(id,"companyId","subscriptionId","planId",gateway,status,"amountCents","refundedAmountCents","paidAt","periodStart","periodEnd","billingInterval",currency,"updatedAt") VALUES ($1,$2,$3,$4,'STRIPE','APPROVED',199,$5,now(),$6,$7,'MONTHLY','BRL',now())`,
    [
      id,
      input.company,
      input.sub,
      input.plan,
      input.refundedAmountCents ?? 0,
      input.start,
      input.end,
    ],
  );
  return id;
}

async function approvedCurrentPeriodPayment(
  pg: PGlite,
  input: { sub: string },
) {
  const id = randomUUID();
  await pg.query(
    `INSERT INTO "Payment"(id,"companyId","subscriptionId","planId",gateway,status,"amountCents","paidAt","periodStart","periodEnd","billingInterval",currency,"updatedAt") SELECT $1,s."companyId",s.id,s."planId",'STRIPE','APPROVED',199,now(),s."currentPeriodStart",s."currentPeriodEnd",s."billingInterval",s.currency,now() FROM "Subscription" s WHERE s.id=$2`,
    [id, input.sub],
  );
  return id;
}

async function expectReview(pg: PGlite) {
  await expect(pg.exec(await migrationSql())).rejects.toThrow(
    'ENTITLEMENT_BACKFILL_REQUIRES_REVIEW',
  );
  await pg.exec('ROLLBACK');
  expect(
    (
      await pg.query(
        `SELECT to_regclass('"SubscriptionEntitlement"') AS relation`,
      )
    ).rows,
  ).toEqual([{ relation: null }]);
}

async function expectMigrationPass(pg: PGlite, sub: string) {
  await pg.exec(await migrationSql());
  return pg.query<{
    origin: string;
    legacy: boolean;
    paymentId: string | null;
    evidencePaymentIds: string[] | null;
    startsAt: Date;
    endsAt: Date;
    graceEndsAt: Date | null;
  }>(
    `SELECT e.origin,e.legacy,NULL::uuid AS "paymentId",e."startsAt",e."endsAt",e."graceEndsAt",array_agg(pe."paymentId" ORDER BY pe."paymentId") FILTER (WHERE pe.id IS NOT NULL) AS "evidencePaymentIds" FROM "SubscriptionEntitlement" e LEFT JOIN "PaymentEvidence" pe ON pe."entitlementId"=e.id WHERE e."subscriptionId"=$1 GROUP BY e.id ORDER BY e."startsAt"`,
    [sub],
  );
}

describe('conservative entitlement migration (embedded PostgreSQL only)', () => {
  it('does not invent an independent legacy grant for a MANUAL period already proven by payment', async () => {
    const pg = await legacyDatabase();
    try {
      const { sub, company, plan, start, end } = await fixture(pg);
      const paymentId = await approvedPayment(pg, {
        sub, company, plan, start: start!, end: end!,
      });
      const rights = await expectMigrationPass(pg, sub);
      expect(rights.rows).toHaveLength(1);
      expect(rights.rows[0]).toMatchObject({
        origin: 'PAYMENT', evidencePaymentIds: [paymentId],
      });
      // Refunding the only proof must not leave an inferred administrative bypass.
      await pg.query(
        `UPDATE "Payment" SET status='REFUNDED',"refundedAmountCents"="amountCents" WHERE id=$1`,
        [paymentId],
      );
      expect((await pg.query(
        `SELECT kalend_subscription_period_covered($1,$2,$3) AS covered`,
        [sub, start, end],
      )).rows).toEqual([{ covered: false }]);
    } finally {
      await pg.close();
    }
  }, 30000);

  it('preserves an exact legacy administrative period without inventing actor or grace permission', async () => {
    const pg = await legacyDatabase();
    try {
      const { sub } = await fixture(pg);
      const before = await pg.query(
        `SELECT * FROM "Subscription" WHERE id=$1`,
        [sub],
      );
      const rights = await expectMigrationPass(pg, sub);
      expect(
        (await pg.query(`SELECT * FROM "Subscription" WHERE id=$1`, [sub]))
          .rows,
      ).toEqual(before.rows);
      expect(rights.rows).toHaveLength(1);
      expect(rights.rows[0]).toMatchObject({
        origin: 'ADMIN_GRANT',
        legacy: true,
        paymentId: null,
        graceEndsAt: null,
      });
    } finally {
      await pg.close();
    }
  }, 30000);

  it('rejects an old approved entitlement that does not cover the current paid period', async () => {
    const pg = await legacyDatabase();
    try {
      const { sub, company, plan } = await fixture(pg, { gateway: 'STRIPE' });
      const oldStart = new Date(Date.now() - 5 * 86400000);
      const oldEnd = new Date(Date.now() - 3 * 86400000);
      await approvedPayment(pg, {
        sub,
        company,
        plan,
        start: oldStart,
        end: oldEnd,
      });
      await pg.query(
        `UPDATE "Subscription" SET "currentPeriodStart"=$2,"currentPeriodEnd"=$3 WHERE id=$1`,
        [
          sub,
          new Date(Date.now() + 86400000),
          new Date(Date.now() + 4 * 86400000),
        ],
      );
      await expectReview(pg);
    } finally {
      await pg.close();
    }
  }, 30000);

  it('rejects partial coverage of the persisted current period', async () => {
    const pg = await legacyDatabase();
    try {
      const {
        sub,
        company,
        plan,
        start: maybeStart,
        end: maybeEnd,
      } = await fixture(pg, {
        gateway: 'STRIPE',
      });
      const start = maybeStart!;
      const end = maybeEnd!;
      await approvedPayment(pg, {
        sub,
        company,
        plan,
        start: new Date(start.getTime() + 3600000),
        end,
      });
      await expectReview(pg);
    } finally {
      await pg.close();
    }
  }, 30000);

  it('accepts complete coverage by one valid approved payment', async () => {
    const pg = await legacyDatabase();
    try {
      const {
        sub,
        company,
        plan,
        start: maybeStart,
        end: maybeEnd,
      } = await fixture(pg, {
        gateway: 'STRIPE',
      });
      const start = maybeStart!;
      const end = maybeEnd!;
      const paymentId = await approvedPayment(pg, {
        sub,
        company,
        plan,
        start,
        end,
      });
      const rights = await expectMigrationPass(pg, sub);
      expect(rights.rows).toHaveLength(1);
      expect(rights.rows[0]).toMatchObject({ origin: 'PAYMENT', evidencePaymentIds: [paymentId] });
    } finally {
      await pg.close();
    }
  }, 30000);

  it.each([
    ['adjacent', [0, 5, 5, 10]],
    ['overlapping', [0, 6, 4, 10]],
  ] as const)(
    'accepts continuous %s evidence for the complete period',
    async (_kind, offsets) => {
      const pg = await legacyDatabase();
      try {
        const {
          sub,
          company,
          plan,
          start: maybeStart,
          end: maybeEnd,
        } = await fixture(pg, {
          gateway: 'STRIPE',
        });
        const start = maybeStart!;
        const end = maybeEnd!;
        const duration = end.getTime() - start.getTime();
        const unit = duration / 10;
        await approvedPayment(pg, {
          sub,
          company,
          plan,
          start: new Date(start.getTime() + unit * offsets[0]),
          end: new Date(start.getTime() + unit * offsets[1]),
        });
        await approvedPayment(pg, {
          sub,
          company,
          plan,
          start: new Date(start.getTime() + unit * offsets[2]),
          end: new Date(start.getTime() + unit * offsets[3]),
        });
        const rights = await expectMigrationPass(pg, sub);
        expect(rights.rows).toHaveLength(2);
      } finally {
        await pg.close();
      }
    },
    30000,
  );

  it('rejects a gap between otherwise valid approved periods', async () => {
    const pg = await legacyDatabase();
    try {
      const {
        sub,
        company,
        plan,
        start: maybeStart,
        end: maybeEnd,
      } = await fixture(pg, {
        gateway: 'STRIPE',
      });
      const start = maybeStart!;
      const end = maybeEnd!;
      const unit = (end.getTime() - start.getTime()) / 10;
      await approvedPayment(pg, {
        sub,
        company,
        plan,
        start,
        end: new Date(start.getTime() + unit * 4),
      });
      await approvedPayment(pg, {
        sub,
        company,
        plan,
        start: new Date(start.getTime() + unit * 5),
        end,
      });
      await expectReview(pg);
    } finally {
      await pg.close();
    }
  }, 30000);

  it('preserves a proven prior period when a paid renewal is advanced', async () => {
    const pg = await legacyDatabase();
    try {
      const {
        sub,
        company,
        plan,
        start: maybeStart,
        end: maybeEnd,
      } = await fixture(pg, {
        gateway: 'STRIPE',
      });
      const start = maybeStart!;
      const end = maybeEnd!;
      const prior = await approvedPayment(pg, {
        sub,
        company,
        plan,
        start,
        end,
      });
      await pg.query(
        `UPDATE "Subscription" SET "currentPeriodStart"="currentPeriodEnd","currentPeriodEnd"="currentPeriodEnd"+interval '1 month' WHERE id=$1`,
        [sub],
      );
      const renewal = await approvedCurrentPeriodPayment(pg, { sub });
      const evidence = await pg.query(
        `SELECT s."currentPeriodStart",s."currentPeriodEnd",p."periodStart",p."periodEnd",p.status,p."paidAt",p."amountCents",p."refundedAmountCents",p."subscriptionId"=s.id AS bound FROM "Subscription" s JOIN "Payment" p ON p."subscriptionId"=s.id WHERE s.id=$1 ORDER BY p."periodStart"`,
        [sub],
      );
      expect(evidence.rows).toHaveLength(2);
      expect(evidence.rows[1]).toMatchObject({
        status: 'APPROVED',
        bound: true,
      });
      const rights = await expectMigrationPass(pg, sub);
      expect(rights.rows.map((row) => row.evidencePaymentIds)).toEqual([[prior], [renewal]]);
    } finally {
      await pg.close();
    }
  }, 30000);

  it('backfills distinct approved Payments for one period as alternative evidence', async () => {
    const pg = await legacyDatabase();
    try {
      const {
        sub,
        company,
        plan,
        start: maybeStart,
        end: maybeEnd,
      } = await fixture(pg, {
        gateway: 'STRIPE',
      });
      const start = maybeStart!;
      const end = maybeEnd!;
      const first = await approvedPayment(pg, { sub, company, plan, start, end });
      const second = await approvedPayment(pg, { sub, company, plan, start, end });
      const rights = await expectMigrationPass(pg, sub);
      expect(rights.rows).toHaveLength(1);
      expect(rights.rows[0]!.evidencePaymentIds).toEqual([first, second].sort());
      expect((await pg.query(
        `SELECT "financialReviewRequired","reviewReason" FROM "PaymentEvidence" WHERE "subscriptionId"=$1 ORDER BY "paymentId"`,
        [sub],
      )).rows).toEqual([
        { financialReviewRequired: true, reviewReason: 'POSSIBLE_DUPLICATE_CHARGE' },
        { financialReviewRequired: true, reviewReason: 'POSSIBLE_DUPLICATE_CHARGE' },
      ]);
    } finally {
      await pg.close();
    }
  }, 30000);

  it('rejects ACTIVE with a NULL currentPeriodEnd rather than infer an unbounded grant', async () => {
    const pg = await legacyDatabase();
    try {
      const { sub } = await fixture(pg, {
        gateway: 'STRIPE',
        start: null,
        end: null,
      });
      await expectReview(pg);
      expect(
        (await pg.query(`SELECT status FROM "Subscription" WHERE id=$1`, [sub]))
          .rows,
      ).toEqual([{ status: 'ACTIVE' }]);
    } finally {
      await pg.close();
    }
  }, 30000);

  it('rejects ACTIVE with a missing currentPeriodStart and future currentPeriodEnd', async () => {
    const pg = await legacyDatabase();
    try {
      await fixture(pg, {
        gateway: 'STRIPE',
        start: null,
        end: new Date(Date.now() + 86400000),
      });
      await expectReview(pg);
    } finally {
      await pg.close();
    }
  }, 30000);

  it('rejects PAST_DUE with NULL period bounds and an active grace claim', async () => {
    const pg = await legacyDatabase();
    try {
      await fixture(pg, {
        gateway: 'STRIPE',
        status: 'PAST_DUE',
        start: null,
        end: null,
        graceEnd: new Date(Date.now() + 86400000),
      });
      await expectReview(pg);
    } finally {
      await pg.close();
    }
  }, 30000);

  it.each([
    [
      'PAST_DUE without an active period or grace claim',
      { status: 'PAST_DUE' },
    ],
    ['PENDING without period bounds', { status: 'PENDING' }],
    ['SUSPENDED without period bounds', { status: 'SUSPENDED' }],
  ] as const)(
    'does not invent evidence for %s',
    async (_description, options) => {
      const pg = await legacyDatabase();
      try {
        const { sub } = await fixture(pg, {
          ...options,
          gateway: 'STRIPE',
          start: null,
          end: null,
        });
        const rights = await expectMigrationPass(pg, sub);
        expect(rights.rows).toHaveLength(0);
      } finally {
        await pg.close();
      }
    },
    30000,
  );

  it('rejects a PAST_DUE grace claim without explicit historical grant permission', async () => {
    const pg = await legacyDatabase();
    try {
      const end = new Date(Date.now() - 3600000);
      await fixture(pg, {
        status: 'PAST_DUE',
        end,
        graceEnd: new Date(Date.now() + 86400000),
      });
      await expectReview(pg);
    } finally {
      await pg.close();
    }
  }, 30000);

  it('preserves a future grace deadline only when the current paid period proves it', async () => {
    const pg = await legacyDatabase();
    try {
      const {
        sub,
        company,
        plan,
        start: maybeStart,
        end: maybeEnd,
      } = await fixture(pg, {
        gateway: 'STRIPE',
        status: 'PAST_DUE',
      });
      const start = maybeStart!;
      const end = maybeEnd!;
      const grace = new Date(end.getTime() + 86400000);
      await pg.query(`UPDATE "Subscription" SET "graceEndsAt"=$2 WHERE id=$1`, [
        sub,
        grace,
      ]);
      await approvedPayment(pg, { sub, company, plan, start, end });
      const storedGrace = await pg.query<{ graceEndsAt: Date }>(
        `SELECT "graceEndsAt" FROM "Subscription" WHERE id=$1`,
        [sub],
      );
      const rights = await expectMigrationPass(pg, sub);
      expect(rights.rows).toHaveLength(1);
      expect(rights.rows[0].graceEndsAt).toEqual(
        storedGrace.rows[0].graceEndsAt,
      );
    } finally {
      await pg.close();
    }
  }, 30000);

  it('rejects evidence from another subscription or company', async () => {
    const pg = await legacyDatabase();
    try {
      const target = await fixture(pg, { gateway: 'STRIPE' });
      const otherSub = randomUUID();
      await pg.query(
        `INSERT INTO "Subscription"(id,"companyId","planId",status,gateway,"currentPeriodStart","currentPeriodEnd","updatedAt") VALUES ($1,$2,$3,'SUSPENDED','STRIPE',$4,$5,now())`,
        [otherSub, target.company, target.plan, target.start, target.end],
      );
      await approvedPayment(pg, {
        sub: otherSub,
        company: target.company,
        plan: target.plan,
        start: target.start!,
        end: target.end!,
      });
      await expectReview(pg);
    } finally {
      await pg.close();
    }
  }, 30000);

  it('rejects a Payment from another Company even when it references the target subscription', async () => {
    const pg = await legacyDatabase();
    try {
      const target = await fixture(pg, { gateway: 'STRIPE' });
      const foreignCompany = randomUUID();
      await pg.query(
        `INSERT INTO "Company"(id,name,slug,status,"updatedAt") VALUES ($1::uuid,'Foreign fixture',$1::text,'ACTIVE',now())`,
        [foreignCompany],
      );
      await approvedPayment(pg, {
        sub: target.sub,
        company: foreignCompany,
        plan: target.plan,
        start: target.start!,
        end: target.end!,
      });
      await expectReview(pg);
    } finally {
      await pg.close();
    }
  }, 30000);

  it('rejects an approved but fully refunded payment as entitlement evidence', async () => {
    const pg = await legacyDatabase();
    try {
      const {
        sub,
        company,
        plan,
        start: maybeStart,
        end: maybeEnd,
      } = await fixture(pg, {
        gateway: 'STRIPE',
      });
      const start = maybeStart!;
      const end = maybeEnd!;
      await approvedPayment(pg, {
        sub,
        company,
        plan,
        start,
        end,
        refundedAmountCents: 199,
      });
      await expectReview(pg);
    } finally {
      await pg.close();
    }
  }, 30000);

  it('backfills distinct Payments for one period as alternative evidence for one right', async () => {
    const pg = await legacyDatabase();
    try {
      const {
        sub,
        company,
        plan,
        start: maybeStart,
      } = await fixture(pg, {
        gateway: 'STRIPE',
        status: 'PENDING',
      });
      const start = maybeStart!;
      const end = new Date(start);
      end.setUTCMonth(end.getUTCMonth() + 1);
      await pg.exec(await migrationSql());
      const firstPayment = await approvedPayment(pg, {
        sub,
        company,
        plan,
        start,
        end,
      });
      const secondPayment = await approvedPayment(pg, {
        sub,
        company,
        plan,
        start,
        end,
      });
      const right = await pg.query<{ id: string }>(
        `INSERT INTO "SubscriptionEntitlement"("subscriptionId",origin,"startsAt","endsAt") VALUES ($1,'PAYMENT',$2,$3) RETURNING id`,
        [sub, start, end],
      );
      for (const paymentId of [firstPayment, secondPayment])
        await pg.query(
          `INSERT INTO "PaymentEvidence"("paymentId","companyId","subscriptionId","entitlementId","startsAt","endsAt") VALUES ($1,$2,$3,$4,$5,$6)`,
          [paymentId, company, sub, right.rows[0]!.id, start, end],
        );
      const rightCount = await pg.query(
        `SELECT count(*)::int AS count FROM "SubscriptionEntitlement" WHERE "subscriptionId"=$1 AND "startsAt"=$2 AND "endsAt"=$3`,
        [sub, start, end],
      );
      expect(rightCount.rows).toEqual([{ count: 1 }]);
      expect(
        (await pg.query(
          `SELECT count(*)::int AS count FROM "PaymentEvidence" WHERE "subscriptionId"=$1`,
          [sub],
        )).rows,
      ).toEqual([{ count: 2 }]);
    } finally {
      await pg.close();
    }
  }, 30000);

  it('excludes a revoked administrative grant from continuous period coverage', async () => {
    const pg = await legacyDatabase();
    try {
      const {
        sub,
        start: maybeStart,
        end: maybeEnd,
      } = await fixture(pg, {
        gateway: 'STRIPE',
        status: 'PENDING',
      });
      const start = maybeStart!;
      const end = maybeEnd!;
      await pg.exec(await migrationSql());
      const actor = randomUUID();
      await pg.query(
        `INSERT INTO "User"(id,name,email,"passwordHash","isActive","isSuperAdmin","updatedAt") VALUES ($1,'Admin',$2,'unused',true,true,now())`,
        [actor, `${actor}@example.test`],
      );
      const right = randomUUID();
      await pg.query(
        `INSERT INTO "SubscriptionEntitlement"(id,"subscriptionId",origin,"startsAt","endsAt","grantedById","grantedAt") VALUES ($1,$2,'ADMIN_GRANT',$3,$4,$5,now())`,
        [right, sub, start, end, actor],
      );
      expect(
        (
          await pg.query(
            `SELECT kalend_subscription_period_covered($1,$2,$3) AS covered`,
            [sub, start, end],
          )
        ).rows,
      ).toEqual([{ covered: true }]);
      await pg.query(
        `UPDATE "SubscriptionEntitlement" SET "revokedAt"=now(),"revokedById"=$2 WHERE id=$1`,
        [right, actor],
      );
      expect(
        (
          await pg.query(
            `SELECT kalend_subscription_period_covered($1,$2,$3) AS covered`,
            [sub, start, end],
          )
        ).rows,
      ).toEqual([{ covered: false }]);
    } finally {
      await pg.close();
    }
  }, 30000);

  it('rolls back every migration object when the review guard fails', async () => {
    const pg = await legacyDatabase();
    try {
      await fixture(pg, { gateway: 'STRIPE', start: null, end: null });
      await expectReview(pg);
      expect(
        (await pg.query(`SELECT to_regtype('"EntitlementOrigin"') AS type`))
          .rows,
      ).toEqual([{ type: null }]);
    } finally {
      await pg.close();
    }
  }, 30000);
});
