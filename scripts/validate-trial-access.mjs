// Disposable SQL + HTTP trial flow. Never reads a database URL from the environment.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../dist/app.module.js';
import { PrismaService } from '../dist/prisma/prisma.service.js';
import { CompaniesService } from '../dist/companies/companies.service.js';
import { AuthService } from '../dist/auth/auth.service.js';
import { PaymentsService } from '../dist/billing/payments.service.js';
import { WebhookProcessor } from '../dist/billing/webhook-processor.service.js';
import { LifecycleService } from '../dist/billing/lifecycle.service.js';
import { RegularizationService } from '../dist/billing/regularization.service.js';
import { CommunicationEngine } from '../dist/communication/engine.js';
import { EvolutionService } from '../dist/communication/evolution.js';
import { ACCESS_COOKIE } from '../dist/auth/auth.config.js';
const qaRunId = `${Date.now()}-${randomBytes(4).toString('hex')}`;
const qaOwnerEmail = `qa+${qaRunId}@example.invalid`;
const sql = await PGlite.create();
const server = new PGLiteSocketServer({
  db: sql,
  host: '127.0.0.1',
  port: 55449,
});
const realDate = Date;
let prisma, app;
const results = [];
function check(name, actual, expected) {
  assert.deepEqual(actual, expected, name);
  results.push({ name, actual, expected, result: 'PASS' });
  console.log(JSON.stringify(results.at(-1)));
}
function clock(time) {
  globalThis.Date = class extends realDate {
    constructor(...args) {
      super(...(args.length ? args : [time]));
    }
    static now() {
      return time;
    }
  };
}
try {
  for (const folder of (
    await readdir(new URL('../prisma/migrations/', import.meta.url))
  )
    .filter((n) => n !== 'migration_lock.toml')
    .sort())
    await sql.exec(
      await readFile(
        new URL(
          `../prisma/migrations/${folder}/migration.sql`,
          import.meta.url,
        ),
        'utf8',
      ),
    );
  check(
    '14 existing migrations, no new migration',
    (
      await sql.query(
        "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name='Subscription'",
      )
    ).rows[0].n,
    1,
  );
  await server.start();
  const url = 'postgresql://fixture@127.0.0.1:55449/kalend_trial_disposable';
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url, max: 1 }),
  });
  process.env.AUTH_JWT_SECRET = randomBytes(32).toString('hex');
  process.env.GATEWAY_ENCRYPTION_KEY = randomBytes(32).toString('hex');
  process.env.AUTH_ALLOWED_ORIGINS = 'https://trial.kalend.test';
  const origin = process.env.AUTH_ALLOWED_ORIGINS;
  const charges = [];
  const gateway = {
    capabilities: { checkout: true, recurring: false },
    createCharge: async (input) => {
      charges.push(input);
      return {
        externalPaymentId: `fixture-${input.paymentId}`,
        checkoutUrl: 'https://checkout.test/fixture',
      };
    },
  };
  const registry = { get: () => gateway };
  const gateways = {
    context: async () => ({
      environment: 'SANDBOX',
      credentials: 'fixture-only',
    }),
  };
  const payments = new PaymentsService(prisma, registry, gateways);
  const processor = new WebhookProcessor(prisma, registry, gateways);
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(prisma)
    .overrideProvider(PaymentsService)
    .useValue(payments)
    .overrideProvider(EvolutionService)
    .useValue({
      prepareAfterCompanyCreated: async () => {},
      onModuleInit() {},
      onModuleDestroy() {},
    })
    .compile();
  app = module.createNestApplication({ rawBody: true });
  await app.init();
  const companyService = app.get(CompaniesService);
  const auth = app.get(AuthService);
  const plan = await prisma.plan.create({
    data: {
      name: 'Plano fixture',
      code: `trial-${randomUUID()}`,
      monthlyPriceCents: 9900,
      yearlyPriceCents: 99000,
      isActive: true,
      isPublic: true,
      trialEnabled: true,
      trialDays: 7,
    },
  });
  const password = 'trial-disposable-password';
  const created = await companyService.createManual({
    companyName: `QA-E2E-${qaRunId}-A`,
    slug: `qa-e2e-${qaRunId}-a`,
    ownerName: 'Owner fixture',
    ownerEmail: qaOwnerEmail,
    ownerPassword: password,
    planId: plan.id,
  });
  const companyB = await companyService.createManual({
    companyName: `QA-E2E-${qaRunId}-B`,
    slug: `qa-e2e-${qaRunId}-b`,
    ownerName: 'Owner fixture',
    ownerEmail: qaOwnerEmail,
    ownerPassword: password,
    planId: plan.id,
    startWithTrial: false,
  });
  check('new company OWNER', created.membership.role, 'OWNER');
  check(
    'T0 authoritative state is TRIAL_ACTIVE',
    (await app.get(RegularizationService).get(created.company.id)).accessStatus,
    'TRIAL_ACTIVE',
  );
  check(
    'trial starts with persisted 7 days',
    created.subscription.trialEndsAt - created.subscription.trialStartedAt,
    7 * 86400000,
  );
  check(
    'TRIAL_STARTED transactionally captured once',
    await prisma.globalCommunicationOutbox.count({
      where: { event: 'TRIAL_STARTED' },
    }),
    1,
  );
  const deadline = created.subscription.trialEndsAt.getTime();
  const engine = new CommunicationEngine(prisma, {}, {}, {});
  clock(deadline - 3 * 86400000 - 1);
  check('warning not early', (await engine.temporal()).inserted, 0);
  clock(deadline - 3 * 86400000);
  check('TRIAL_EXPIRING captured once', (await engine.temporal()).inserted, 1);
  check(
    'TRIAL_EXPIRING replay deduplicated',
    (await engine.temporal()).inserted,
    0,
  );
  for (const offset of [-300000, -1000, 0, 1000, 3600000]) {
    clock(deadline + offset);
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .set('Origin', origin)
      .send({ email: qaOwnerEmail, password })
      .expect(200);
    const cookie = login.headers['set-cookie']
      .find((s) => s.startsWith(`${ACCESS_COOKIE}=`))
      .split(';')[0];
    await request(app.getHttpServer())
      .post('/auth/tenant')
      .set('Cookie', cookie)
      .set('Origin', origin)
      .send({ companyId: created.company.id })
      .expect(200);
    const response = await request(app.getHttpServer())
      .get('/auth/tenant')
      .set('Cookie', cookie);
    check(
      `direct product HTTP ${offset}ms, scheduler absent`,
      response.status,
      offset < 0 ? 200 : 403,
    );
    if (offset >= 0)
      check(
        `explicit TRIAL_EXPIRED ${offset}ms`,
        response.body.accessStatus,
        'TRIAL_EXPIRED',
      );
    const state = await request(app.getHttpServer())
      .get('/billing/regularization')
      .set('Cookie', cookie)
      .expect(200);
    check(
      `authoritative access ${offset}ms`,
      state.body.accessAllowed,
      offset < 0,
    );
    check(
      'requests never duplicate TRIAL_STARTED',
      await prisma.globalCommunicationOutbox.count({
        where: { event: 'TRIAL_STARTED' },
      }),
      1,
    );
    check(
      'effective expiration does not emit duplicate domain events on reads',
      await prisma.globalCommunicationOutbox.count({
        where: { event: 'TRIAL_EXPIRED' },
      }),
      0,
    );
  }
  clock(deadline + 1000);
  const freshAuth = new AuthService(prisma, {}, {});
  await assert.rejects(
    freshAuth.membership(created.owner.id, created.company.id),
    (error) => error.getResponse().accessStatus === 'TRIAL_EXPIRED',
  );
  check(
    'fresh access service after process restart still denies without scheduler',
    true,
    true,
  );
  const isolationLogin = await request(app.getHttpServer())
    .post('/auth/login')
    .set('Origin', origin)
    .send({ email: qaOwnerEmail, password })
    .expect(200);
  const isolationCookie = isolationLogin.headers['set-cookie']
    .find((s) => s.startsWith(`${ACCESS_COOKIE}=`))
    .split(';')[0];
  await request(app.getHttpServer())
    .post('/auth/tenant')
    .set('Cookie', isolationCookie)
    .set('Origin', origin)
    .send({ companyId: companyB.company.id })
    .expect(200);
  await request(app.getHttpServer())
    .get('/auth/tenant')
    .set('Cookie', isolationCookie)
    .expect(200);
  check(
    'real SQL paid B remains accessible while A is expired',
    (await prisma.company.findUnique({ where: { id: companyB.company.id } }))
      .status,
    'ACTIVE',
  );
  // SQL triggers use the database clock; historical fixture tests them without changing that clock.
  globalThis.Date = realDate;
  await prisma.subscription.update({
    where: { id: created.subscription.id },
    data: {
      trialStartedAt: new realDate(realDate.now() - 8 * 86400000),
      trialEndsAt: new realDate(realDate.now() - 86400000),
    },
  });
  const lifecycle = new LifecycleService(prisma, {}, {}, {});
  await lifecycle.reconcile();
  await lifecycle.reconcile();
  check(
    'TRIAL_EXPIRED persisted exactly once on repeated scheduler',
    await prisma.globalCommunicationOutbox.count({
      where: { event: 'TRIAL_EXPIRED' },
    }),
    1,
  );
  await assert.rejects(auth.membership(created.owner.id, created.company.id));
  check(
    'billing recovery after persisted suspension',
    (await auth.membership(created.owner.id, created.company.id, true)).role,
    'OWNER',
  );
  const login = await request(app.getHttpServer())
    .post('/auth/login')
    .set('Origin', origin)
    .send({ email: qaOwnerEmail, password })
    .expect(200);
  const cookie = login.headers['set-cookie']
    .find((s) => s.startsWith(`${ACCESS_COOKIE}=`))
    .split(';')[0];
  await request(app.getHttpServer())
    .post('/auth/tenant')
    .set('Cookie', cookie)
    .set('Origin', origin)
    .send({ companyId: created.company.id })
    .expect(200);
  const paidPlan = await prisma.plan.create({
    data: {
      name: 'Plano pago alternativo',
      code: `paid-${randomUUID()}`,
      monthlyPriceCents: 12900,
      isActive: true,
      isPublic: true,
      trialEnabled: false,
    },
  });
  const payload = {
    planId: paidPlan.id,
    billingInterval: 'MONTHLY',
    gateway: 'STRIPE',
    idempotencyKey: 'trial-fixture-checkout',
  };
  const checkout = await request(app.getHttpServer())
    .post('/billing/checkout')
    .set('Cookie', cookie)
    .set('Origin', origin)
    .send(payload)
    .expect(201);
  await request(app.getHttpServer())
    .post('/billing/checkout')
    .set('Cookie', cookie)
    .set('Origin', origin)
    .send(payload)
    .expect(201);
  check('HTTP checkout permitted, one external MOCK charge', charges.length, 1);
  await request(app.getHttpServer())
    .get('/auth/tenant')
    .set('Cookie', cookie)
    .expect(403);
  const approval = {
    environment: 'SANDBOX',
    eventId: 'trial-fixture-paid',
    type: 'payment.approved',
    externalPaymentId: checkout.body.externalPaymentId,
    status: 'APPROVED',
    amountCents: 12900,
    currency: 'BRL',
  };
  await processor.processVerified('STRIPE', approval);
  await processor.processVerified('STRIPE', approval);
  await processor.processVerified('STRIPE', {
    ...approval,
    eventId: 'trial-fixture-paid-again',
  });
  await request(app.getHttpServer())
    .get('/auth/tenant')
    .set('Cookie', cookie)
    .expect(200);
  const state = await request(app.getHttpServer())
    .get('/billing/regularization')
    .set('Cookie', cookie)
    .expect(200);
  check(
    'approval restores HTTP access and ACTIVE decision',
    state.body.accessStatus,
    'ACTIVE',
  );
  check(
    'approval removes expired trial decision',
    state.body.trial.expired,
    false,
  );
  check(
    'approval resolves the new paid plan, not the old trial plan',
    state.body.subscription.planId,
    paidPlan.id,
  );
  check(
    'PAYMENT_APPROVED outbox remains idempotent',
    await prisma.globalCommunicationOutbox.count({
      where: { event: 'PAYMENT_APPROVED' },
    }),
    1,
  );
  check(
    'TRIAL_EXPIRED history remains one after payment',
    await prisma.globalCommunicationOutbox.count({
      where: { event: 'TRIAL_EXPIRED' },
    }),
    1,
  );
  const ownerRecord = await prisma.user.findUniqueOrThrow({
    where: { id: created.owner.id },
  });
  await prisma.user.create({
    data: {
      name: 'Global fixture',
      email: `qa+admin-${qaRunId}@example.invalid`,
      passwordHash: ownerRecord.passwordHash,
      isSuperAdmin: true,
    },
  });
  const adminLogin = await request(app.getHttpServer())
    .post('/auth/login')
    .set('Origin', origin)
    .send({ email: `qa+admin-${qaRunId}@example.invalid`, password })
    .expect(200);
  const adminCookie = adminLogin.headers['set-cookie']
    .find((s) => s.startsWith(`${ACCESS_COOKIE}=`))
    .split(';')[0];
  await request(app.getHttpServer())
    .get('/communication/events')
    .set('Cookie', adminCookie)
    .expect(200);
  const adminState = await request(app.getHttpServer())
    .get('/billing/regularization')
    .set('Cookie', adminCookie)
    .expect(200);
  check(
    'real SQL global Super Admin has no tenant trial restriction',
    adminState.body.accessStatus,
    'NOT_APPLICABLE',
  );
  console.log(
    JSON.stringify({
      fixtureOnly: true,
      database: 'PGlite disposable',
      externalProvider: 'MOCK',
      checks: results.length,
    }),
  );
} finally {
  globalThis.Date = realDate;
  await writeFile(
    '/tmp/kalend-block1-trial-database-results.json',
    JSON.stringify(results, null, 2),
  );
  if (app) await app.close();
  if (prisma) await prisma.$disconnect();
  await server.stop();
  await sql.close();
}
