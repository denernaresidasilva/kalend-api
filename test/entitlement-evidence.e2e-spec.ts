import { Test } from '@nestjs/testing';
import request from 'supertest';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { EvolutionService } from '../src/communication/evolution.js';
import { ACCESS_COOKIE } from '../src/auth/auth.config.js';
import { ProductAccessGuard } from '../src/billing/product-access.guard.js';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { BillingDomain } from '../src/billing/billing-domain.js';
import { EntitlementsService } from '../src/billing/entitlements.service.js';
import { RegularizationService } from '../src/billing/regularization.service.js';
import { createAdminGrant } from '../src/billing/admin-grant.js';
import { entitledWhere } from '../src/billing/commercial-policy.js';
import { AuthService } from '../src/auth/auth.service.js';
import { FinanceService } from '../src/finance/finance.service.js';
import { nextPeriod } from '../src/common/period.js';
import { CompaniesService } from '../src/companies/companies.service.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';

describe('commercial entitlement evidence (real Prisma and embedded PGlite PostgreSQL)', () => {
  let pg: PGlite, socket: PGLiteSocketServer, db: PrismaClient;
  let companyId: string, planId: string, ownerId: string, adminId: string;
  const day = 86400000;
  const domain = () => new BillingDomain({ graceDays: 1 });
  const current = () => new EntitlementsService(db as never).current(companyId);
  const events = (event: string) =>
    db.globalCommunicationOutbox.count({ where: { companyId, event } });
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
  }, 120000);
  afterAll(async () => {
    await db?.$disconnect();
    await socket?.stop();
    await pg?.close();
  });
  beforeEach(async () => {
    await pg.exec('TRUNCATE "Company", "User", "Plan" CASCADE');
    companyId = (
      await db.company.create({
        data: {
          name: 'Evidence fixture',
          slug: randomUUID(),
          status: 'ACTIVE',
        },
      })
    ).id;
    planId = (
      await db.plan.create({
        data: { name: 'Plan', code: randomUUID(), monthlyPriceCents: 199 },
      })
    ).id;
    ownerId = (
      await db.user.create({
        data: {
          name: 'Owner',
          email: `${randomUUID()}@example.test`,
          passwordHash: 'unused',
        },
      })
    ).id;
    adminId = (
      await db.user.create({
        data: {
          name: 'Admin',
          email: `${randomUUID()}@example.test`,
          passwordHash: 'unused',
          isSuperAdmin: true,
        },
      })
    ).id;
    await db.membership.create({
      data: { companyId, userId: ownerId, role: 'OWNER' },
    });
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
    vi.unstubAllEnvs();
  });
  async function pending(gateway: 'STRIPE' | 'QA_SIMULATION' = 'STRIPE') {
    const periodStart = new Date(Date.now() - 1000);
    const s = await db.subscription.create({
      data: {
        companyId,
        planId,
        gateway,
        environment: 'SANDBOX',
        status: 'PENDING',
      },
    });
    const p = await db.payment.create({
      data: {
        companyId,
        planId,
        subscriptionId: s.id,
        gateway,
        environment: 'SANDBOX',
        status: 'PENDING',
        amountCents: 199,
        periodStart,
        periodEnd: nextPeriod(periodStart, 'MONTHLY'),
        externalPaymentId: randomUUID(),
        creationState: 'CREATED',
      },
    });
    return { s, p };
  }
  async function transition(
    p: Awaited<ReturnType<typeof pending>>['p'],
    status: 'APPROVED' | 'OVERDUE' | 'FAILED' | 'REFUNDED',
    days = 1,
  ) {
    return db.$transaction(
      (tx) =>
        new BillingDomain({ graceDays: days }).payment(
          tx,
          p.gateway as 'STRIPE',
          {
            eventId: `${p.id}:${status}`,
            type: status,
            status,
            externalPaymentId: p.externalPaymentId!,
            externalReference: p.id,
            environment: 'SANDBOX',
            amountCents: 199,
            currency: 'BRL',
          },
        ),
      { isolationLevel: 'Serializable' },
    );
  }
  it.each(['PENDING', 'APPROVED'] as const)(
    'company deletion preserves %s payment and its persisted history', async (status) => {
      const { p } = await pending();
      if (status === 'APPROVED') await transition(p, 'APPROVED');
      const before = await db.payment.findUniqueOrThrow({ where: { id: p.id } });
      const service = new CompaniesService(db as never);
      await expect(service.remove(companyId, { confirmationName: 'Evidence fixture' }))
        .rejects.toThrow('COMPANY_FINANCIAL_HISTORY_PRESERVED');
      expect(await db.company.count({ where: { id: companyId } })).toBe(1);
      expect(await db.payment.findUnique({ where: { id: p.id } })).toEqual(before);
      if (status === 'APPROVED')
        expect(await db.paymentEvidence.count({ where: { paymentId: p.id } })).toBe(1);
    },
  );
  it('an authenticated suspended owner can read their recovery inbox without product access', async () => {
    await db.company.update({ where: { id: companyId }, data: { status: 'SUSPENDED', isActive: false } });
    const auth = { user: { id: ownerId }, session: { selectedCompanyId: companyId } };
    await expect(new NotificationsService(db as never).count(auth as never))
      .resolves.toMatchObject({ unreadCount: 0, companyId });
    await expect(current()).rejects.toThrow();
  });
  it.each(['DISABLED', 'LEGACY_UNKNOWN'] as const)(
    'an administratively %s selected tenant cannot expose its notification scope', async (administrativeStatus) => {
      await db.company.update({ where: { id: companyId }, data: { administrativeStatus } });
      const auth = { user: { id: ownerId }, session: { selectedCompanyId: companyId } };
      await expect(new NotificationsService(db as never).count(auth as never))
        .rejects.toThrow('Empresa sem vínculo autorizado.');
    },
  );
  it('company deletion preserves an administrative grant without a Payment', async () => {
    const start = new Date();
    const end = nextPeriod(start, 'MONTHLY');
    const sub = await db.subscription.create({ data: {
      companyId, planId, gateway: 'MANUAL', status: 'ACTIVE',
      currentPeriodStart: start, currentPeriodEnd: end,
    } });
    const grant = await db.$transaction((tx) => createAdminGrant(tx, adminId, sub.id, start, end));
    await expect(new CompaniesService(db as never).remove(companyId, { confirmationName: 'Evidence fixture' }))
      .rejects.toThrow('COMPANY_FINANCIAL_HISTORY_PRESERVED');
    expect(await db.subscriptionEntitlement.findUnique({ where: { id: grant.id } })).toEqual(grant);
    expect(await db.payment.count({ where: { companyId } })).toBe(0);
  });
  it('company deletion preserves an external subscription even before its first Payment', async () => {
    const sub = await db.subscription.create({ data: {
      companyId, planId, gateway: 'STRIPE', status: 'PENDING', environment: 'SANDBOX',
      externalSubscriptionId: randomUUID(),
    } });
    await expect(new CompaniesService(db as never).remove(companyId, { confirmationName: 'Evidence fixture' }))
      .rejects.toThrow('COMPANY_FINANCIAL_HISTORY_PRESERVED');
    expect(await db.subscription.findUnique({ where: { id: sub.id } })).toEqual(sub);
    expect(await db.payment.count({ where: { companyId } })).toBe(0);
  });
  async function paid(
    expired = true,
    gateway: 'STRIPE' | 'QA_SIMULATION' = 'STRIPE',
  ) {
    const { s, p } = await pending(gateway);
    const start = new Date(Date.now() + (expired ? -30 * day - 3600000 : 0));
    const end = nextPeriod(start, 'MONTHLY');
    const approved = await db.payment.update({
      where: { id: p.id },
      data: {
        status: 'APPROVED',
        paidAt: start,
        periodStart: start,
        periodEnd: end,
      },
      include: { subscription: true },
    });
    await db.$transaction((tx) =>
      domain().activatePaid(tx, approved, new Date(end.getTime() - 1)),
    );
    return {
      s: await db.subscription.findUniqueOrThrow({ where: { id: s.id } }),
      p: approved,
    };
  }
  it.each([0, 1, 999])(
    'first never-paid OVERDUE grants no entitlement or grace (%i days)',
    async (days) => {
      const { s, p } = await pending();
      await expect(current()).rejects.toThrow();
      await transition(p, 'OVERDUE', days);
      const after = await db.subscription.findUniqueOrThrow({
        where: { id: s.id },
      });
      expect(after.status).toBe('PAST_DUE');
      expect(after.graceEndsAt).toBeNull();
      expect(
        (await db.payment.findUniqueOrThrow({ where: { id: p.id } })).status,
      ).toBe('OVERDUE');
      await expect(current()).rejects.toThrow();
      expect(await events('SUBSCRIPTION_GRACE_PERIOD')).toBe(0);
      const recovery = await new RegularizationService(
        db as never,
        { findPublic: async () => [] } as never,
        { list: async () => [] } as never,
        {} as never,
      ).get(companyId);
      expect(recovery.accessAllowed).toBe(false);
      expect(recovery.recoverySubscriptionId).toBe(s.id);
      const auth = new AuthService(db as never, {} as never, {} as never);
      await expect(
        auth.membership(ownerId, companyId, true),
      ).resolves.toBeDefined();
      await expect(
        auth.membership(ownerId, companyId, false),
      ).rejects.toThrow();
    },
  );
  it('rejects a forged future grace on an unpaid PAST_DUE subscription in authorization and SQL capture', async () => {
    const { s } = await pending();
    await db.subscription.update({
      where: { id: s.id },
      data: { status: 'PAST_DUE', graceEndsAt: new Date(Date.now() + day) },
    });
    // The former authorization predicate accepts this exact persisted row.
    expect(
      await db.subscription.findFirst({
        where: {
          companyId,
          status: 'PAST_DUE',
          graceEndsAt: { gt: new Date() },
        },
      }),
    ).not.toBeNull();
    await expect(current()).rejects.toThrow();
    expect(await events('SUBSCRIPTION_GRACE_PERIOD')).toBe(0);
    await expect(
      db.$transaction((tx) => domain().beginGrace(tx, s.id, companyId)),
    ).rejects.toThrow();
  });
  it.each(['STRIPE', 'QA_SIMULATION'] as const)(
    'preserves legitimate paid grace, its bound and idempotency (%s)',
    async (gateway) => {
      const { s } = await paid(true, gateway);
      await db.$transaction((tx) => domain().elapsed(tx, s, new Date()));
      const due = await db.subscription.findUniqueOrThrow({
        where: { id: s.id },
      });
      expect(due.status).toBe('PAST_DUE');
      expect(due.graceEndsAt?.getTime()).toBe(
        s.currentPeriodEnd!.getTime() + day,
      );
      expect((await current()).id).toBe(s.id);
      expect(await events('SUBSCRIPTION_GRACE_PERIOD')).toBe(1);
      await db.$transaction((tx) => domain().elapsed(tx, due, new Date()));
      expect(await events('SUBSCRIPTION_GRACE_PERIOD')).toBe(1);
      expect(await db.subscriptionEntitlement.count()).toBe(1);
      const boundary = due.graceEndsAt!;
      expect(
        await db.subscription.count({
          where: entitledWhere(companyId, new Date(boundary.getTime() - 1)),
        }),
      ).toBe(1);
      expect(
        await db.subscription.count({
          where: entitledWhere(companyId, boundary),
        }),
      ).toBe(0);
      await db.$transaction((tx) => domain().elapsed(tx, due, boundary));
      expect(
        (await db.subscription.findUniqueOrThrow({ where: { id: s.id } }))
          .status,
      ).toBe('SUSPENDED');
      expect(await events('SUBSCRIPTION_SUSPENDED')).toBe(1);
      if (gateway === 'QA_SIMULATION')
        expect(
          (await new FinanceService(db as never).summary()).revenueCents,
        ).toBe(0);
    },
  );
  it('renewal OVERDUE uses the previously approved period on the same subscription', async () => {
    const { s } = await paid();
    const p = await db.payment.create({
      data: {
        companyId,
        planId,
        subscriptionId: s.id,
        gateway: 'STRIPE',
        environment: 'SANDBOX',
        status: 'PENDING',
        amountCents: 199,
        externalPaymentId: randomUUID(),
        periodStart: s.currentPeriodEnd,
        periodEnd: new Date(s.currentPeriodEnd!.getTime() + 30 * day),
      },
    });
    await transition(p, 'OVERDUE');
    expect((await current()).id).toBe(s.id);
    expect(
      (
        await db.subscription.findUniqueOrThrow({ where: { id: s.id } })
      ).graceEndsAt?.getTime(),
    ).toBe(s.currentPeriodEnd!.getTime() + day);
  });
  it('zero grace suspends an expired paid right without persisting a zero window', async () => {
    const { s } = await paid();
    await db.$transaction((tx) =>
      new BillingDomain({ graceDays: 0 }).elapsed(tx, s, new Date()),
    );
    expect(
      (await db.subscription.findUniqueOrThrow({ where: { id: s.id } }))
        .graceEndsAt,
    ).toBeNull();
    await expect(current()).rejects.toThrow();
    expect(await events('SUBSCRIPTION_GRACE_PERIOD')).toBe(0);
  });
  it('preserves a concurrently valid paid subscription while an independent attempt becomes overdue', async () => {
    const active = await paid(false);
    const unpaid = await pending();
    await transition(unpaid.p, 'OVERDUE');
    expect((await current()).id).toBe(active.s.id);
    expect(
      (await db.company.findUniqueOrThrow({ where: { id: companyId } })).status,
    ).toBe('ACTIVE');
    expect(
      (await db.subscription.findUniqueOrThrow({ where: { id: unpaid.s.id } }))
        .graceEndsAt,
    ).toBeNull();
  });
  it('a payment of another subscription/tenant cannot be attached as evidence', async () => {
    const active = await paid(false);
    const unpaid = await pending();
    await expect(
      pg.query(
        `INSERT INTO "PaymentEvidence" ("paymentId","companyId","subscriptionId","startsAt","endsAt") VALUES ($1,$2,$3,$4,$5)`,
        [active.p.id, companyId, unpaid.s.id, active.p.periodStart, active.p.periodEnd],
      ),
    ).rejects.toThrow('PAYMENT_EVIDENCE_SCOPE_MISMATCH');
    const other = await db.company.create({
      data: { name: 'Other', slug: randomUUID() },
    });
    const foreign = await db.subscription.create({
      data: { companyId: other.id, planId, status: 'PENDING' },
    });
    await expect(
      pg.query(
        `INSERT INTO "PaymentEvidence" ("paymentId","companyId","subscriptionId","startsAt","endsAt") VALUES ($1,$2,$3,$4,$5)`,
        [active.p.id, other.id, foreign.id, active.p.periodStart, active.p.periodEnd],
      ),
    ).rejects.toThrow('PAYMENT_EVIDENCE_SCOPE_MISMATCH');
  });
  it.each(['DISABLED', 'LEGACY_UNKNOWN'] as const)(
    'administrative %s blocks all entitlement and paid activation',
    async (administrativeStatus) => {
      const { s, p } = await pending();
      await db.company.update({
        where: { id: companyId },
        data: { administrativeStatus },
      });
      await transition(p, 'APPROVED');
      await expect(current()).rejects.toThrow();
      expect(
        (await db.subscription.findUniqueOrThrow({ where: { id: s.id } }))
          .status,
      ).toBe('PENDING');
      expect(await db.subscriptionEntitlement.count()).toBe(0);
      expect(
        (await db.company.findUniqueOrThrow({ where: { id: companyId } }))
          .administrativeStatus,
      ).toBe(administrativeStatus);
    },
  );
  it.each([0, 1])(
    'explicit administrative grant preserves its period and only its authorized grace (%i)',
    async (days) => {
      const { s } = await pending();
      const end = new Date(Date.now() - 1000),
        start = new Date(end.getTime() - day);
      const grant = await db.$transaction((tx) =>
        createAdminGrant(tx, adminId, s.id, start, end, days),
      );
      const active = await db.subscription.update({
        where: { id: s.id },
        data: {
          status: 'ACTIVE',
          currentPeriodStart: start,
          currentPeriodEnd: end,
          gateway: 'MANUAL',
        },
      });
      await db.$transaction((tx) => domain().elapsed(tx, active, new Date()));
      expect(grant.grantedById).toBe(adminId);
      expect(grant.grantedAt).not.toBeNull();
      if (days) {
        expect((await current()).id).toBe(s.id);
        expect(await events('SUBSCRIPTION_GRACE_PERIOD')).toBe(1);
      } else {
        await expect(current()).rejects.toThrow();
        expect(await events('SUBSCRIPTION_GRACE_PERIOD')).toBe(0);
      }
      expect(await db.payment.count({ where: { status: 'APPROVED' } })).toBe(0);
    },
  );
  it('OWNER cannot create an administrative right; invalid bounds are rejected', async () => {
    const { s } = await pending();
    await expect(
      db.$transaction((tx) =>
        createAdminGrant(
          tx,
          ownerId,
          s.id,
          new Date(),
          new Date(Date.now() + day),
          1,
        ),
      ),
    ).rejects.toThrow('ADMIN_GRANT_FORBIDDEN');
    await expect(
      db.$transaction((tx) =>
        createAdminGrant(
          tx,
          adminId,
          s.id,
          new Date(),
          new Date(Date.now() + day),
          1000,
        ),
      ),
    ).rejects.toThrow();
    expect(await db.subscriptionEntitlement.count()).toBe(0);
  });
  it('legacy administrative grant retains valid period but no inferred grace', async () => {
    const { s } = await pending();
    const start = new Date(Date.now() - day),
      end = new Date(Date.now() + day);
    await db.subscriptionEntitlement.create({
      data: {
        subscriptionId: s.id,
        origin: 'ADMIN_GRANT',
        startsAt: start,
        endsAt: end,
        legacy: true,
      },
    });
    const active = await db.subscription.update({
      where: { id: s.id },
      data: {
        status: 'ACTIVE',
        currentPeriodStart: start,
        currentPeriodEnd: end,
        gateway: 'MANUAL',
      },
    });
    expect((await current()).id).toBe(s.id);
    await db.$transaction((tx) => domain().elapsed(tx, active, end));
    expect(
      await db.subscription.count({ where: entitledWhere(companyId, end) }),
    ).toBe(0);
    expect(await events('SUBSCRIPTION_GRACE_PERIOD')).toBe(0);
  });
  it('revoked grant cannot authorize access or grace', async () => {
    const { s } = await pending();
    const start = new Date(Date.now() - day),
      end = new Date(Date.now() + day);
    const g = await db.$transaction((tx) =>
      createAdminGrant(tx, adminId, s.id, start, end, 1),
    );
    await db.subscription.update({
      where: { id: s.id },
      data: {
        status: 'ACTIVE',
        currentPeriodStart: start,
        currentPeriodEnd: end,
      },
    });
    expect((await current()).id).toBe(s.id);
    await db.subscriptionEntitlement.update({
      where: { id: g.id },
      data: { revokedAt: new Date(), revokedById: adminId },
    });
    await expect(current()).rejects.toThrow();
  });
  it('payment reversal preserves an overlapping administrative grant, whose revocation leaves payment history intact', async () => {
    const { s, p } = await paid(false);
    const grant = await db.$transaction((tx) => createAdminGrant(
      tx, adminId, s.id, p.periodStart!, p.periodEnd!, 0,
    ));
    await transition(p, 'REFUNDED');
    await expect(current()).resolves.toBeDefined();
    expect(await db.payment.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ status: 'REFUNDED' });
    await db.subscriptionEntitlement.update({
      where: { id: grant.id },
      data: { revokedAt: new Date(), revokedById: adminId },
    });
    await expect(current()).rejects.toThrow();
    expect(await db.paymentEvidence.findUniqueOrThrow({ where: { paymentId: p.id } })).toMatchObject({ status: 'REVOKED' });
  });
  it('full refund invalidates evidence; partial refund preserves provisional access and signals review', async () => {
    const { p } = await paid(false);
    await db.$transaction((tx) =>
      domain().payment(tx, 'STRIPE', {
        eventId: randomUUID(),
        type: 'refund',
        status: 'REFUNDED',
        externalPaymentId: p.externalPaymentId!,
        environment: 'SANDBOX',
        amountCents: 199,
        currency: 'BRL',
        refundedAmountCents: 1,
      }),
    );
    await expect(current()).resolves.toBeDefined();
    expect(await db.paymentEvidence.findUniqueOrThrow({ where: { paymentId: p.id } })).toMatchObject({
      status: 'APPLIED', financialReviewRequired: true,
      reviewReason: 'PARTIAL_REFUND_REVIEW_REQUIRED',
    });
    await transition(p, 'REFUNDED');
    await expect(current()).rejects.toThrow();
  });
  it('an explicit chargeback revokes only its payment evidence and later approval restores it', async () => {
    const { p } = await paid(false);
    await db.$transaction((tx) => domain().payment(tx, 'STRIPE', {
      eventId: randomUUID(), type: 'PAYMENT_CHARGEBACK_DISPUTE', status: 'FAILED',
      externalPaymentId: p.externalPaymentId!, environment: 'SANDBOX',
      amountCents: p.amountCents, currency: p.currency,
    }));
    expect(await db.paymentEvidence.findUniqueOrThrow({ where: { paymentId: p.id } })).toMatchObject({
      status: 'REVOKED', reviewReason: 'PAYMENT_CHARGEBACK',
    });
    await expect(current()).rejects.toThrow();
    await transition(p, 'APPROVED');
    expect(await db.paymentEvidence.findUniqueOrThrow({ where: { paymentId: p.id } })).toMatchObject({
      status: 'APPLIED', revokedAt: null,
    });
    expect((await current()).id).toBe(p.subscriptionId);
  });
  it('approval is idempotent, cancellation denies access, same-subscription payment recovers suspension', async () => {
    const { s, p } = await pending();
    await transition(p, 'APPROVED');
    await transition(p, 'APPROVED');
    expect(await db.subscriptionEntitlement.count()).toBe(1);
    expect(await events('PAYMENT_APPROVED')).toBe(1);
    await db.subscription.update({
      where: { id: s.id },
      data: { status: 'SUSPENDED' },
    });
    await expect(current()).rejects.toThrow();
    await db.$transaction((tx) => domain().reactivate(tx, p.id, companyId));
    expect((await current()).id).toBe(s.id);
    expect(await events('SUBSCRIPTION_REACTIVATED')).toBe(1);
    expect(await db.subscription.count()).toBe(1);
    await db.subscription.update({
      where: { id: s.id },
      data: { status: 'CANCELED' },
    });
    await expect(current()).rejects.toThrow();
    await expect(
      db.$transaction((tx) => domain().reactivate(tx, p.id, companyId)),
    ).rejects.toThrow();
  });
  it('real HTTP AdminGuard requires Super Admin and records the authenticated grant/revocation actor', async () => {
    const origin = 'https://dev.kalend.tech';
    vi.stubEnv('AUTH_JWT_SECRET', randomBytes(32).toString('hex'));
    vi.stubEnv('AUTH_ALLOWED_ORIGINS', origin);
    const password = 'ephemeral-test-password';
    const passwordHash = await bcrypt.hash(password, 4);
    await db.user.updateMany({
      where: { id: { in: [ownerId, adminId] } },
      data: { passwordHash },
    });
    const prepare = vi.fn().mockResolvedValue(undefined);
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(db)
      .overrideProvider(EvolutionService)
      .useValue({ prepareAfterCompanyCreated: prepare })
      .compile();
    const app = module.createNestApplication();
    await app.init();
    const body = {
      companyName: 'Administrative fixture',
      slug: randomUUID(),
      ownerName: 'Owner',
      ownerEmail: (await db.user.findUniqueOrThrow({ where: { id: ownerId } }))
        .email,
      ownerPassword: password,
      planId,
      startWithTrial: false,
      adminGraceDays: 1,
    };
    const login = async (id: string) => {
      const user = await db.user.findUniqueOrThrow({ where: { id } });
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .set('Origin', origin)
        .send({ email: user.email, password })
        .expect(200);
      return (res.headers['set-cookie'] as unknown as string[])
        .find((c) => c.startsWith(ACCESS_COOKIE + '='))!
        .split(';')[0];
    };
    try {
      await request(app.getHttpServer())
        .post('/companies/manual')
        .set('Origin', origin)
        .send(body)
        .expect(401);
      const ownerCookie = await login(ownerId);
      await request(app.getHttpServer())
        .post('/companies/manual')
        .set('Cookie', ownerCookie)
        .set('Origin', origin)
        .send(body)
        .expect(403);
      const adminCookie = await login(adminId);
      await request(app.getHttpServer())
        .post('/companies/manual')
        .set('Cookie', adminCookie)
        .set('Origin', origin)
        .send({ ...body, grantedById: ownerId })
        .expect(400);
      const result = await request(app.getHttpServer())
        .post('/companies/manual')
        .set('Cookie', adminCookie)
        .set('Origin', origin)
        .send(body)
        .expect(201);
      const id = result.body.company.id;
      const grant = await db.subscriptionEntitlement.findFirstOrThrow({
        where: { subscription: { companyId: id } },
      });
      expect(grant).toMatchObject({
        origin: 'ADMIN_GRANT',
        grantedById: adminId,
        legacy: false,
      });
      expect(grant.graceEndsAt!.getTime() - grant.endsAt.getTime()).toBe(day);
      expect(await db.payment.count({ where: { companyId: id } })).toBe(0);
      expect(prepare).toHaveBeenCalledTimes(1);
      const path = `/companies/${id}/entitlements/${grant.id}/revoke`;
      await request(app.getHttpServer())
        .post(path)
        .set('Cookie', ownerCookie)
        .set('Origin', origin)
        .expect(403);
      await request(app.getHttpServer())
        .post(`/companies/${companyId}/entitlements/${grant.id}/revoke`)
        .set('Cookie', adminCookie)
        .set('Origin', origin)
        .expect(404);
      await request(app.getHttpServer())
        .post(path)
        .set('Cookie', adminCookie)
        .set('Origin', origin)
        .expect(201);
      const revoked = await db.subscriptionEntitlement.findUniqueOrThrow({
        where: { id: grant.id },
      });
      await request(app.getHttpServer())
        .post(path)
        .set('Cookie', adminCookie)
        .set('Origin', origin)
        .expect(201);
      expect(
        await db.subscriptionEntitlement.findUnique({
          where: { id: grant.id },
        }),
      ).toEqual(revoked);
      expect(revoked.revokedById).toBe(adminId);
      expect(revoked.revokedAt).not.toBeNull();
      await expect(
        new EntitlementsService(db as never).current(id),
      ).rejects.toThrow();
    } finally {
      await app.close();
    }
  });
  it('the product guard denies an unpaid candidate while the recovery membership remains usable', async () => {
    const { p } = await pending();
    await transition(p, 'OVERDUE');
    const guard = new ProductAccessGuard(new EntitlementsService(db as never));
    await expect(
      guard.canActivate({
        switchToHttp: () => ({ getRequest: () => ({ tenant: { companyId } }) }),
      } as never),
    ).rejects.toThrow();
    await expect(
      new AuthService(db as never, {} as never, {} as never).membership(
        ownerId,
        companyId,
        true,
      ),
    ).resolves.toBeDefined();
  });
  it('concurrent duplicate approvals persist one right and one event', async () => {
    const { p } = await pending();
    await Promise.all([transition(p, 'APPROVED'), transition(p, 'APPROVED')]);
    expect(await db.subscriptionEntitlement.count()).toBe(1);
    expect(await events('PAYMENT_APPROVED')).toBe(1);
  });
  it('maps distinct valid payments for the same period to one right and flags duplicate finance', async () => {
    const { p } = await pending();
    await transition(p, 'APPROVED');
    const second = await db.payment.create({
      data: {
        companyId: p.companyId,
        planId: p.planId!,
        subscriptionId: p.subscriptionId!,
        gateway: p.gateway,
        environment: p.environment,
        status: 'PENDING',
        amountCents: p.amountCents,
        currency: p.currency,
        billingInterval: p.billingInterval,
        creationState: 'CREATED',
        externalPaymentId: randomUUID(),
        periodStart: p.periodStart!,
        periodEnd: p.periodEnd!,
      },
    });
    await transition(second, 'APPROVED');
    expect(await db.subscriptionEntitlement.count({
      where: { subscriptionId: p.subscriptionId!, startsAt: p.periodStart!, endsAt: p.periodEnd! },
    })).toBe(1);
    expect(await db.paymentEvidence.count({
      where: { subscriptionId: p.subscriptionId!, entitlementId: { not: null }, status: 'APPLIED' },
    })).toBe(2);
    expect(await db.paymentEvidence.count({ where: { financialReviewRequired: true } })).toBe(1);
  });
  it('a reversed alternative preserves the interval until every valid payment is reversed', async () => {
    const { p } = await pending();
    await transition(p, 'APPROVED');
    const second = await db.payment.create({
      data: {
        companyId: p.companyId, planId: p.planId!, subscriptionId: p.subscriptionId!,
        gateway: p.gateway, environment: p.environment, status: 'PENDING',
        amountCents: p.amountCents, currency: p.currency, billingInterval: p.billingInterval,
        creationState: 'CREATED', externalPaymentId: randomUUID(),
        periodStart: p.periodStart!, periodEnd: p.periodEnd!,
      },
    });
    await transition(second, 'APPROVED');
    await transition(p, 'REFUNDED');
    await expect(current()).resolves.toBeDefined();
    expect(await db.paymentEvidence.findUniqueOrThrow({ where: { paymentId: p.id } })).toMatchObject({ status: 'REVOKED' });
    expect(await db.paymentEvidence.findUniqueOrThrow({ where: { paymentId: second.id } })).toMatchObject({ status: 'APPLIED' });
    await transition(second, 'REFUNDED');
    await expect(current()).rejects.toThrow();
  });
  it('adjacent contracted periods remain continuous without overlap', async () => {
    const { p } = await pending();
    await transition(p, 'APPROVED');
    const start = p.periodEnd!;
    const next = await db.payment.create({
      data: {
        companyId: p.companyId, planId: p.planId!, subscriptionId: p.subscriptionId!,
        gateway: p.gateway, environment: p.environment, status: 'PENDING',
        amountCents: p.amountCents, currency: p.currency, billingInterval: p.billingInterval,
        creationState: 'CREATED', externalPaymentId: randomUUID(),
        periodStart: start, periodEnd: nextPeriod(start, 'MONTHLY'),
      },
    });
    await transition(next, 'APPROVED');
    const rights = await db.subscriptionEntitlement.findMany({
      where: { subscriptionId: p.subscriptionId!, origin: 'PAYMENT' },
      orderBy: { startsAt: 'asc' },
    });
    expect(rights).toHaveLength(2);
    expect(rights[0]!.endsAt).toEqual(rights[1]!.startsAt);
    expect((await current()).id).toBe(p.subscriptionId);
  });
  it('unions a valid partially overlapping contracted interval and flags financial review', async () => {
    const { p } = await pending();
    await transition(p, 'APPROVED');
    const secondStart = new Date(p.periodStart!.getTime() + 15 * day);
    const secondEnd = nextPeriod(secondStart, 'MONTHLY');
    const second = await db.payment.create({
      data: {
        companyId: p.companyId,
        planId: p.planId!,
        subscriptionId: p.subscriptionId!,
        gateway: p.gateway,
        environment: p.environment,
        status: 'PENDING',
        amountCents: p.amountCents,
        currency: p.currency,
        billingInterval: p.billingInterval,
        creationState: 'CREATED',
        externalPaymentId: randomUUID(),
        periodStart: secondStart,
        periodEnd: secondEnd,
      },
    });
    await transition(second, 'APPROVED');
    expect(await db.subscriptionEntitlement.count({ where: { subscriptionId: p.subscriptionId! } })).toBe(2);
    expect(await db.paymentEvidence.findUniqueOrThrow({ where: { paymentId: second.id } })).toMatchObject({
      status: 'APPLIED', reviewReason: 'POSSIBLE_DUPLICATE_CHARGE', financialReviewRequired: true,
    });
    expect((await current()).id).toBe(p.subscriptionId);
    const [coverage] = await db.$queryRaw<{ covered: boolean }[]>`
      SELECT kalend_subscription_period_covered(${p.subscriptionId}::uuid, ${p.periodStart}::timestamp, ${secondEnd}::timestamp) AS covered`;
    expect(coverage?.covered).toBe(true);
  });
  it('a late overdue notification cannot reopen a suspended entitlement window', async () => {
    const { s } = await paid();
    await db.$transaction((tx) => domain().elapsed(tx, s, new Date()));
    const due = await db.subscription.findUniqueOrThrow({
      where: { id: s.id },
    });
    await db.$transaction((tx) => domain().elapsed(tx, due, due.graceEndsAt!));
    const retry = await db.payment.create({
      data: {
        companyId,
        planId,
        subscriptionId: s.id,
        gateway: 'STRIPE',
        environment: 'SANDBOX',
        status: 'PENDING',
        amountCents: 199,
        externalPaymentId: randomUUID(),
      },
    });
    await transition(retry, 'OVERDUE');
    expect(
      (await db.subscription.findUniqueOrThrow({ where: { id: s.id } })).status,
    ).toBe('SUSPENDED');
    expect(await events('SUBSCRIPTION_GRACE_PERIOD')).toBe(1);
    await expect(current()).rejects.toThrow();
  });

  it('provider PAST_DUE and PAYMENT_FAILED cannot create initial paid grace', async () => {
    const { s, p } = await pending();
    await transition(p, 'FAILED');
    expect(
      (await db.subscription.findUniqueOrThrow({ where: { id: s.id } }))
        .graceEndsAt,
    ).toBeNull();
    await db.subscription.update({
      where: { id: s.id },
      data: { externalSubscriptionId: 'mandate-fixture' },
    });
    await db.$transaction((tx) =>
      domain().subscription(tx, 'STRIPE', {
        kind: 'subscription',
        environment: 'SANDBOX',
        eventId: randomUUID(),
        type: 'past_due',
        status: 'PAST_DUE',
        externalSubscriptionId: 'mandate-fixture',
        externalReference: s.id,
      }),
    );
    await expect(current()).rejects.toThrow();
    expect(await events('SUBSCRIPTION_GRACE_PERIOD')).toBe(0);
  });
  it('evidence period and an already authorized grace bound are immutable in PostgreSQL', async () => {
    const { s } = await pending();
    const start = new Date(Date.now() - day),
      end = new Date(Date.now() + day);
    const g = await db.$transaction((tx) =>
      createAdminGrant(tx, adminId, s.id, start, end, 1),
    );
    await expect(
      pg.query(
        `UPDATE "SubscriptionEntitlement" SET "endsAt"="endsAt"+interval '1 hour' WHERE id=$1`,
        [g.id],
      ),
    ).rejects.toThrow('ENTITLEMENT_EVIDENCE_IMMUTABLE');
    await expect(
      pg.query(
        `UPDATE "SubscriptionEntitlement" SET "graceEndsAt"="graceEndsAt"+interval '1 hour' WHERE id=$1`,
        [g.id],
      ),
    ).rejects.toThrow('ENTITLEMENT_GRACE_IMMUTABLE');
    expect(
      await db.subscriptionEntitlement.findUnique({ where: { id: g.id } }),
    ).toEqual(g);
  });
});
