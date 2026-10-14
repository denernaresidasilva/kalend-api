import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Test } from '@nestjs/testing';
import { UnauthorizedException, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  QaSimulationController,
  CommercialController,
} from '../src/billing/billing.module.js';
import { QaSimulationService } from '../src/billing/qa-simulation.service.js';
import { runQaCli } from '../src/billing/qa-simulation-cli.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import { PaymentsService } from '../src/billing/payments.service.js';
import { GatewayRegistry } from '../src/billing/gateway.provider.js';
import { RegularizationService } from '../src/billing/regularization.service.js';
import { TenantGuard } from '../src/auth/tenant.guard.js';
import { AuthConfig } from '../src/auth/auth.config.js';
import { AdminGuard } from '../src/common/admin.guard.js';
import { EntitlementsService } from '../src/billing/entitlements.service.js';
import { FinanceService } from '../src/finance/finance.service.js';
import { DashboardService } from '../src/dashboard/dashboard.service.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';
import { CommunicationEngine } from '../src/communication/engine.js';
import { SecretVault } from '../src/billing/secret-vault.js';
import { StripeAdapter } from '../src/billing/adapters/stripe.adapter.js';
import { MercadoPagoAdapter } from '../src/billing/adapters/mercado-pago.adapter.js';
import { PagBankAdapter } from '../src/billing/adapters/pagbank.adapter.js';
import { AsaasAdapter } from '../src/billing/adapters/asaas.adapter.js';
import { LifecycleService } from '../src/billing/lifecycle.service.js';

describe('commercial QA HTTP and persisted domain (ephemeral local database)', () => {
  let db: PGlite,
    socket: PGLiteSocketServer,
    prisma: PrismaClient,
    app: INestApplication;
  let companyId: string, otherId: string, planId: string, ownerId: string;
  const actorId = randomUUID();
  const externalCalls: ReturnType<typeof vi.spyOn>[] = [];
  const transportSend = vi.fn();
  const network = vi.fn(() => {
    throw new Error('External HTTP forbidden in QA tests');
  });
  function runtime() {
    vi.stubEnv('EVOLUTION_WEBHOOK_BASE_URL', 'https://api-dev.kalend.tech');
    vi.stubEnv('DATABASE_URL', 'postgresql://test:test@127.0.0.1/kalend_dev');
    vi.stubEnv('BILLING_PUBLIC_API_URL', 'https://api-dev.kalend.tech');
    vi.stubEnv('COMMERCIAL_QA_SIMULATION_ENABLED', 'true');
    vi.stubEnv('QA_COMMUNICATION_COMPANY_IDS', companyId);
    vi.stubEnv('QA_COMMUNICATION_ENABLED', 'true');
    vi.stubEnv('QA_COMMUNICATION_EMAIL_ALLOWLIST', 'qa@example.test');
    vi.stubEnv('BILLING_GRACE_DAYS', '3');
    vi.stubEnv('AUTH_ALLOWED_ORIGINS', 'https://qa.example.test');
    vi.stubEnv('GATEWAY_ENCRYPTION_KEY', 'ab'.repeat(32));
  }
  beforeAll(async () => {
    db = new PGlite();
    const migrations = new URL('../prisma/migrations/', import.meta.url);
    for (const name of (await readdir(migrations)).sort()) {
      if (name !== 'migration_lock.toml')
        await db.exec(
          await readFile(new URL(`${name}/migration.sql`, migrations), 'utf8'),
        );
    }
    socket = new PGLiteSocketServer({ db, host: '127.0.0.1', port: 0 });
    await socket.start();
    prisma = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: `postgresql://test:test@${socket.getServerConn()}/test`,
        max: 1,
      }),
    });
    // Real AdminGuard + Origin validation; only session resolution is mocked.
    const module = await Test.createTestingModule({
      controllers: [QaSimulationController, CommercialController],
      providers: [
        QaSimulationService,
        AdminGuard,
        TenantGuard,
        AuthConfig,
        {
          provide: PaymentsService,
          useValue: new PaymentsService(
            prisma as never,
            new GatewayRegistry(),
            {} as never,
          ),
        },
        { provide: RegularizationService, useValue: {} },
        { provide: PrismaService, useValue: prisma },
        {
          provide: AuthService,
          useValue: {
            membership: async () => ({ id: randomUUID(), role: 'OWNER' }),
            authenticate: async (cookie?: string) => {
              if (!['admin', 'member'].includes(cookie ?? ''))
                throw new UnauthorizedException();
              return {
                user: {
                  id: actorId,
                  isSuperAdmin: cookie === 'admin',
                  isActive: true,
                },
                session: { selectedCompanyId: companyId },
              };
            },
          },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    for (const Adapter of [
      StripeAdapter,
      MercadoPagoAdapter,
      PagBankAdapter,
      AsaasAdapter,
    ]) {
      for (const name of Object.getOwnPropertyNames(Adapter.prototype)) {
        if (
          name !== 'constructor' &&
          typeof Adapter.prototype[name] === 'function'
        )
          externalCalls.push(
            vi.spyOn(Adapter.prototype, name).mockImplementation(() => {
              throw new Error('External adapter forbidden');
            }),
          );
      }
    }
    vi.stubGlobal('fetch', network);
  }, 30000);
  beforeEach(async () => {
    companyId = randomUUID();
    otherId = randomUUID();
    planId = randomUUID();
    ownerId = randomUUID();
    runtime();
    await prisma.company.createMany({
      data: [
        {
          id: companyId,
          name: 'Ephemeral QA',
          slug: companyId,
          status: 'ACTIVE',
        },
        { id: otherId, name: 'Other tenant', slug: otherId, status: 'ACTIVE' },
      ],
    });
    await prisma.plan.create({
      data: {
        id: planId,
        name: 'DEV Catalog',
        code: planId,
        monthlyPriceCents: 9900,
        yearlyPriceCents: 99900,
      },
    });
    await prisma.user.create({
      data: {
        id: ownerId,
        email: `${ownerId}@example.test`,
        name: 'QA Owner',
        passwordHash: 'test-only',
      },
    });
    await prisma.membership.create({
      data: { companyId, userId: ownerId, role: 'OWNER' },
    });
  });
  afterEach(() => {
    for (const spy of externalCalls) expect(spy).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
    expect(transportSend).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await socket?.stop();
    await db?.close();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  function post(body: unknown, cookie = 'admin') {
    return request(app.getHttpServer())
      .post('/billing/qa-simulation')
      .set('Origin', 'https://qa.example.test')
      .set('Cookie', `__Host-kalend_access=${cookie}`)
      .send(body);
  }
  async function pending(key = 'attempt') {
    const result = await post({
      companyId,
      action: 'PAYMENT_PENDING',
      planId,
      billingInterval: 'MONTHLY',
      idempotencyKey: key,
    }).expect(201);
    return result.body as {
      paymentId: string;
      subscriptionId: string;
      duplicate: boolean;
    };
  }
  async function transition(paymentId: string, action: string) {
    return (await post({ companyId, paymentId, action }).expect(201)).body;
  }
  async function cli(args: string[]) {
    const output = vi.fn();
    const close = vi.fn();
    await runQaCli(
      args,
      async () => ({ service: app.get(QaSimulationService), close }),
      output,
    );
    expect(close).toHaveBeenCalledTimes(1);
    return output.mock.calls[0][0];
  }
  function cliPending(key = 'cli-attempt') {
    return cli([
      '--company',
      companyId,
      '--action',
      'PAYMENT_PENDING',
      '--plan',
      planId,
      '--interval',
      'MONTHLY',
      '--key',
      key,
    ]);
  }
  it('CLI PENDING and APPROVED share the endpoint service, retain idempotency and record OS provenance', async () => {
    const p = await cliPending();
    const repeated = await cliPending();
    expect(repeated).toMatchObject({ paymentId: p.paymentId, duplicate: true });
    await cli([
      '--company',
      companyId,
      '--action',
      'PAYMENT_APPROVED',
      '--payment',
      p.paymentId,
    ]);
    const approvedAgain = await cli([
      '--company',
      companyId,
      '--action',
      'PAYMENT_APPROVED',
      '--payment',
      p.paymentId,
    ]);
    expect(approvedAgain.duplicate).toBe(true);
    expect(await prisma.payment.count({ where: { companyId } })).toBe(1);
    expect(await prisma.subscription.count({ where: { companyId } })).toBe(1);
    expect(
      await prisma.payment.findUnique({ where: { id: p.paymentId } }),
    ).toMatchObject({
      gateway: 'QA_SIMULATION',
      environment: 'SANDBOX',
      status: 'APPROVED',
      amountCents: 9900,
    });
    for (const action of ['PAYMENT_PENDING', 'PAYMENT_APPROVED']) {
      expect(
        await prisma.globalCommunicationOutbox.count({
          where: { companyId, event: action },
        }),
      ).toBe(1);
      const journal = await prisma.webhookEvent.findFirstOrThrow({
        where: { companyId, eventType: action },
      });
      expect(journal.payload).toMatchObject({
        source: 'QA_SIMULATION',
        execution: 'CLI',
        operator: expect.any(String),
        operatorUid: expect.any(Number),
      });
      expect(journal.payload).not.toHaveProperty('actorId');
    }
  });
  it('CLI check is read-only and never creates a payment, journal or outbox event', async () => {
    const before = await prisma.globalCommunicationOutbox.count({
      where: { companyId },
    });
    expect(await cli(['--company', companyId, '--check'])).toMatchObject({
      execution: 'CLI',
      environment: 'DEV',
      readOnly: true,
      safeToSimulate: true,
      enumAvailable: true,
    });
    expect(await prisma.payment.count({ where: { companyId } })).toBe(0);
    expect(await prisma.webhookEvent.count({ where: { companyId } })).toBe(0);
    expect(
      await prisma.globalCommunicationOutbox.count({ where: { companyId } }),
    ).toBe(before);
  });
  it('CLI blocks PROD with flag=true, disabled flag and non-QA tenant before writes', async () => {
    vi.stubEnv('EVOLUTION_WEBHOOK_BASE_URL', 'https://api.kalend.tech');
    vi.stubEnv('BILLING_PUBLIC_API_URL', 'https://api.kalend.tech');
    vi.stubEnv('DATABASE_URL', 'postgresql://test:test@127.0.0.1/kalend');
    await expect(cliPending()).rejects.toThrow(
      'COMMERCIAL_QA_SIMULATION_BLOCKED',
    );
    runtime();
    vi.stubEnv('COMMERCIAL_QA_SIMULATION_ENABLED', 'false');
    await expect(cliPending()).rejects.toThrow(
      'COMMERCIAL_QA_SIMULATION_BLOCKED',
    );
    runtime();
    vi.stubEnv('QA_COMMUNICATION_COMPANY_IDS', otherId);
    await expect(cliPending()).rejects.toThrow(
      'COMMERCIAL_QA_SIMULATION_BLOCKED',
    );
    expect(await prisma.payment.count({ where: { companyId } })).toBe(0);
  });
  it('CLI blocks nonexistent and inactive QA companies with no payment/subscription writes', async () => {
    const missing = randomUUID();
    vi.stubEnv('QA_COMMUNICATION_COMPANY_IDS', `${companyId},${missing}`);
    await expect(
      cli([
        '--company',
        missing,
        '--action',
        'PAYMENT_PENDING',
        '--plan',
        planId,
        '--interval',
        'MONTHLY',
        '--key',
        'missing',
      ]),
    ).rejects.toThrow('QA_COMPANY_NOT_ACTIVE');
    await prisma.company.update({
      where: { id: companyId },
      data: { isActive: false },
    });
    await expect(cliPending()).rejects.toThrow('QA_COMPANY_NOT_ACTIVE');
    await expect(cli(['--company', companyId, '--check'])).rejects.toThrow(
      'QA_COMPANY_NOT_ACTIVE',
    );
    expect(await prisma.payment.count({ where: { companyId } })).toBe(0);
    expect(await prisma.subscription.count({ where: { companyId } })).toBe(0);
  });
  it('HTTP callers cannot request operational CLI authorization', async () => {
    await post({
      companyId,
      action: 'PAYMENT_PENDING',
      planId,
      billingInterval: 'MONTHLY',
      idempotencyKey: 'impersonation',
      execution: 'CLI',
    }).expect(400);
    await post(
      {
        companyId,
        action: 'PAYMENT_PENDING',
        planId,
        billingInterval: 'MONTHLY',
        idempotencyKey: 'impersonation',
      },
      'member',
    ).expect(403);
    expect(await prisma.payment.count({ where: { companyId } })).toBe(0);
  });
  it('applies only the enum migration; no QA gateway configuration exists', async () => {
    const sql = await readFile(
      new URL(
        '../prisma/migrations/20261014120000_commercial_qa_simulation/migration.sql',
        import.meta.url,
      ),
      'utf8',
    );
    expect(sql.replace(/--[^\n]*/g, '').trim()).toBe(
      'ALTER TYPE "PaymentGateway" ADD VALUE \'QA_SIMULATION\';',
    );
    expect(
      await prisma.gatewayConfiguration.count({
        where: { gateway: 'QA_SIMULATION' },
      }),
    ).toBe(0);
  });
  it('enforces authentication, Super Admin and Origin using real guards', async () => {
    const body = { companyId, action: 'PAYMENT_PENDING' };
    await post(body, 'unknown').expect(401);
    await post(body, 'member').expect(403);
    await request(app.getHttpServer())
      .post('/billing/qa-simulation')
      .set('Cookie', '__Host-kalend_access=admin')
      .send(body)
      .expect(403);
  });
  it('normal POST /billing/checkout rejects QA_SIMULATION even in authorized DEV', async () => {
    await request(app.getHttpServer())
      .post('/billing/checkout')
      .set('Origin', 'https://qa.example.test')
      .set('Cookie', '__Host-kalend_access=admin')
      .send({
        planId,
        gateway: 'QA_SIMULATION',
        billingInterval: 'MONTHLY',
        idempotencyKey: 'normal-checkout',
      })
      .expect(400);
    expect(await prisma.payment.count({ where: { companyId } })).toBe(0);
  });
  it('blocks PROD even with flag=true, DEV without flag, and non-QA companies before writes', async () => {
    const body = {
      companyId,
      action: 'PAYMENT_PENDING',
      planId,
      billingInterval: 'MONTHLY',
      idempotencyKey: 'blocked',
    };
    vi.stubEnv('EVOLUTION_WEBHOOK_BASE_URL', 'https://api.kalend.tech');
    vi.stubEnv('BILLING_PUBLIC_API_URL', 'https://api.kalend.tech');
    vi.stubEnv('DATABASE_URL', 'postgresql://test:test@127.0.0.1/kalend');
    await post(body).expect(403);
    runtime();
    vi.stubEnv('COMMERCIAL_QA_SIMULATION_ENABLED', 'false');
    await post(body).expect(403);
    runtime();
    await post({ ...body, companyId: otherId }).expect(403);
    expect(await prisma.payment.count({ where: { companyId } })).toBe(0);
  });
  it('blocks inactive/nonexistent company and rejects financial values/secrets', async () => {
    await prisma.company.update({
      where: { id: companyId },
      data: { isActive: false },
    });
    await post({
      companyId,
      action: 'PAYMENT_PENDING',
      planId,
      billingInterval: 'MONTHLY',
      idempotencyKey: 'inactive',
    }).expect(403);
    await post({ companyId, action: 'PAYMENT_PENDING', amountCents: 1 }).expect(
      400,
    );
    await post({
      companyId,
      action: 'PAYMENT_PENDING',
      credentials: 'test',
    }).expect(400);
  });
  it('PENDING binds catalog price and QA origin exactly once without granting access', async () => {
    const first = await pending();
    const repeated = await pending();
    expect(repeated).toMatchObject({ ...first, duplicate: true });
    await transition(first.paymentId, 'PAYMENT_PENDING');
    expect(await prisma.payment.count({ where: { companyId } })).toBe(1);
    expect(await prisma.subscription.count({ where: { companyId } })).toBe(1);
    expect(
      await prisma.payment.findUnique({ where: { id: first.paymentId } }),
    ).toMatchObject({
      gateway: 'QA_SIMULATION',
      environment: 'SANDBOX',
      status: 'PENDING',
      amountCents: 9900,
      companyId,
      planId,
    });
    expect(
      await prisma.globalCommunicationOutbox.count({
        where: { companyId, event: 'PAYMENT_PENDING' },
      }),
    ).toBe(1);
    await expect(
      new EntitlementsService(prisma as never).current(companyId),
    ).rejects.toThrow();
  });
  it('concurrent requests keep a single Payment, Subscription and captured event', async () => {
    const [a, b] = await Promise.all([
      pending('concurrent'),
      pending('concurrent'),
    ]);
    expect(a.paymentId).toBe(b.paymentId);
    expect(await prisma.payment.count({ where: { companyId } })).toBe(1);
    expect(await prisma.subscription.count({ where: { companyId } })).toBe(1);
    expect(await prisma.webhookEvent.count({ where: { companyId } })).toBe(1);
    const events = await prisma.globalCommunicationOutbox.findMany({
      where: { companyId, event: 'PAYMENT_PENDING' },
    });
    expect(events).toHaveLength(1);
    expect(events[0].businessKey).toBe(
      `QA_SIMULATION:PAYMENT_PENDING:${a.paymentId}`,
    );
  });
  it('APPROVED uses the same Payment, unlocks DB-backed access immediately and excludes QA revenue', async () => {
    const p = await pending();
    const access = new EntitlementsService(prisma as never);
    await expect(access.current(companyId)).rejects.toThrow();
    await transition(p.paymentId, 'PAYMENT_APPROVED');
    await transition(p.paymentId, 'PAYMENT_APPROVED');
    expect((await access.current(companyId)).id).toBe(p.subscriptionId);
    expect(await prisma.payment.count({ where: { companyId } })).toBe(1);
    expect(
      await prisma.globalCommunicationOutbox.count({
        where: { companyId, event: 'PAYMENT_APPROVED' },
      }),
    ).toBe(1);
    expect(
      (await new FinanceService(prisma as never).summary()).revenueCents,
    ).toBe(0);
    expect(
      (await new DashboardService(prisma as never).summary()).payments
        .revenueCents,
    ).toBe(0);
    const real = await prisma.payment.create({
      data: {
        companyId: otherId,
        gateway: 'STRIPE',
        environment: 'PRODUCTION',
        amountCents: 12500,
        status: 'APPROVED',
        paidAt: new Date(),
      },
    });
    expect(
      (await new FinanceService(prisma as never).summary()).revenueCents,
    ).toBe(12500);
    expect(
      (await new DashboardService(prisma as never).summary()).payments
        .monthlyRevenueCents,
    ).toBe(12500);
    await prisma.payment.delete({ where: { id: real.id } });
    await post({
      companyId,
      paymentId: p.paymentId,
      action: 'PAYMENT_FAILED',
    }).expect(409);
  });
  it.each(['PAYMENT_FAILED', 'PAYMENT_OVERDUE'])(
    '%s preserves regularization and is idempotent',
    async (action) => {
      const p = await pending();
      await transition(p.paymentId, action);
      await transition(p.paymentId, action);
      expect(
        await prisma.payment.findUnique({ where: { id: p.paymentId } }),
      ).toMatchObject({ status: action.slice(8) });
      expect(
        await prisma.subscription.findUnique({
          where: { id: p.subscriptionId },
        }),
      ).toMatchObject({ status: 'PAST_DUE' });
      expect(
        await prisma.globalCommunicationOutbox.count({
          where: { companyId, event: action },
        }),
      ).toBe(1);
      await transition(p.paymentId, 'PAYMENT_APPROVED');
      expect(
        (await new EntitlementsService(prisma as never).current(companyId))
          .status,
      ).toBe('ACTIVE');
    },
  );
  it('GRACE and REACTIVATED use persisted paid entitlement and are idempotent', async () => {
    const p = await pending();
    await transition(p.paymentId, 'PAYMENT_APPROVED');
    await transition(p.paymentId, 'SUBSCRIPTION_GRACE_PERIOD');
    await transition(p.paymentId, 'SUBSCRIPTION_GRACE_PERIOD');
    expect(
      (await new EntitlementsService(prisma as never).current(companyId))
        .status,
    ).toBe('PAST_DUE');
    await transition(p.paymentId, 'SUBSCRIPTION_REACTIVATED');
    await transition(p.paymentId, 'SUBSCRIPTION_REACTIVATED');
    expect(
      (await new EntitlementsService(prisma as never).current(companyId))
        .status,
    ).toBe('ACTIVE');
    for (const event of [
      'SUBSCRIPTION_GRACE_PERIOD',
      'SUBSCRIPTION_REACTIVATED',
    ])
      expect(
        await prisma.globalCommunicationOutbox.count({
          where: { companyId, event },
        }),
      ).toBe(1);
  });
  it.each(['SUBSCRIPTION_SUSPENDED', 'SUBSCRIPTION_CANCELLED'])(
    '%s applies the real access gate; inactive company stays blocked on retry',
    async (action) => {
      const p = await pending();
      await transition(p.paymentId, 'PAYMENT_APPROVED');
      await transition(p.paymentId, action);
      await expect(
        new EntitlementsService(prisma as never).current(companyId),
      ).rejects.toThrow();
      expect(
        await prisma.company.findUnique({ where: { id: companyId } }),
      ).toMatchObject({ isActive: false, status: 'SUSPENDED' });
      await post({ companyId, paymentId: p.paymentId, action }).expect(403);
      expect(
        await prisma.globalCommunicationOutbox.count({
          where: { companyId, event: action },
        }),
      ).toBe(1);
    },
  );
  it('SUSPENDED/REACTIVATED/CANCELLED are idempotent while company remains active; no paid proof means no reactivation', async () => {
    // Existing valid QA entitlement keeps the company active, as required by policy.
    await prisma.subscription.create({
      data: {
        companyId,
        planId,
        gateway: 'QA_SIMULATION',
        environment: 'SANDBOX',
        status: 'ACTIVE',
        currentPeriodEnd: new Date(Date.now() + 86400000),
        createdAt: new Date(Date.now() - 60000),
      },
    });
    const p = await pending();
    await post({
      companyId,
      paymentId: p.paymentId,
      action: 'SUBSCRIPTION_REACTIVATED',
    }).expect(409);
    await transition(p.paymentId, 'PAYMENT_APPROVED');
    for (const action of [
      'SUBSCRIPTION_SUSPENDED',
      'SUBSCRIPTION_REACTIVATED',
      'SUBSCRIPTION_CANCELLED',
    ]) {
      await transition(p.paymentId, action);
      expect(await transition(p.paymentId, action)).toMatchObject({
        duplicate: true,
      });
      expect(
        await prisma.globalCommunicationOutbox.count({
          where: { companyId, event: action },
        }),
      ).toBe(1);
    }
    expect(
      await prisma.subscription.findUnique({ where: { id: p.subscriptionId } }),
    ).toMatchObject({ status: 'CANCELED' });
    await post({
      companyId,
      paymentId: p.paymentId,
      action: 'PAYMENT_FAILED',
    }).expect(409);
  });
  it('denies IDOR between two allowlisted tenants and rejects real payment origin', async () => {
    vi.stubEnv('QA_COMMUNICATION_COMPANY_IDS', `${companyId},${otherId}`);
    const p = await pending();
    await post({
      companyId: otherId,
      paymentId: p.paymentId,
      action: 'PAYMENT_APPROVED',
    }).expect(403);
    expect(
      await prisma.payment.findUnique({ where: { id: p.paymentId } }),
    ).toMatchObject({ status: 'PENDING' });
    const real = await prisma.payment.create({
      data: {
        companyId,
        gateway: 'STRIPE',
        environment: 'SANDBOX',
        amountCents: 9900,
        status: 'PENDING',
      },
    });
    await post({
      companyId,
      paymentId: real.id,
      action: 'PAYMENT_APPROVED',
    }).expect(403);
    expect(
      await prisma.company.findUnique({ where: { id: otherId } }),
    ).toMatchObject({ status: 'ACTIVE', isActive: true });
    await prisma.payment.delete({ where: { id: real.id } });
  });
  it('QA approval preserves real subscriptions and users, including in the same tenant', async () => {
    const realSub = await prisma.subscription.create({
      data: {
        companyId,
        planId,
        gateway: 'MANUAL',
        status: 'TRIALING',
        trialEndsAt: new Date(Date.now() + 86400000),
      },
    });
    const user = await prisma.user.findUnique({ where: { id: ownerId } });
    const p = await pending();
    await transition(p.paymentId, 'PAYMENT_APPROVED');
    expect(
      await prisma.subscription.findUnique({ where: { id: realSub.id } }),
    ).toEqual(realSub);
    expect(await prisma.user.findUnique({ where: { id: ownerId } })).toEqual(
      user,
    );
    expect(
      await prisma.company.findUnique({ where: { id: otherId } }),
    ).toMatchObject({ status: 'ACTIVE', isActive: true });
  });
  it('produces notifications/templates/deliveries once through existing engines without sends', async () => {
    const p = await pending();
    await transition(p.paymentId, 'PAYMENT_APPROVED');
    await prisma.user.update({
      where: { id: ownerId },
      data: { email: 'qa@example.test' },
    });
    await prisma.globalCommunicationProvider.upsert({
      where: { provider: 'SMTP' },
      update: { enabled: true, environment: 'SANDBOX' },
      create: {
        provider: 'SMTP',
        environment: 'SANDBOX',
        enabled: true,
        config: {},
      },
    });
    for (const event of ['PAYMENT_PENDING', 'PAYMENT_APPROVED'])
      await prisma.globalCommunicationTemplate.upsert({
        where: { event_channel: { event, channel: 'EMAIL' } },
        update: {},
        create: {
          event,
          channel: 'EMAIL',
          provider: 'SMTP',
          enabled: true,
          content: { subject: 'QA {{empresa}}', text: '{{nome}} {{valor}}' },
        },
      });
    const notifications = new NotificationsService(prisma as never);
    await notifications.ingest({ companyIds: [companyId], qaMode: true });
    await notifications.ingest({ companyIds: [companyId], qaMode: true });
    expect(
      await prisma.notification.count({
        where: { companyId, type: 'pagamento' },
      }),
    ).toBe(2);
    const engine = new CommunicationEngine(
      prisma as never,
      new SecretVault(),
      {
        resolveProvider: vi.fn().mockResolvedValue('SMTP'),
        deliveryEnvironment: vi.fn().mockResolvedValue('SANDBOX'),
      } as never,
      { get: vi.fn().mockReturnValue({ send: transportSend }) } as never,
    );
    await engine.expand({ companyIds: [companyId] });
    expect(
      await prisma.globalCommunicationDelivery.count({
        where: { outbox: { companyId } },
      }),
    ).toBe(0);
    await engine.expand({ companyIds: [companyId], qaMode: true });
    await engine.expand({ companyIds: [companyId], qaMode: true });
    expect(
      await prisma.globalCommunicationDelivery.count({
        where: { outbox: { companyId } },
      }),
    ).toBe(2);
    await engine.processOne();
    expect(transportSend).not.toHaveBeenCalled();
    await transition(p.paymentId, 'PAYMENT_APPROVED');
    expect(
      await prisma.globalCommunicationOutbox.count({
        where: {
          companyId,
          event: { in: ['PAYMENT_PENDING', 'PAYMENT_APPROVED'] },
        },
      }),
    ).toBe(2);
  });
  it('reconciliation never looks up an adapter for a QA payment', async () => {
    await pending();
    const get = vi.fn(() => {
      throw new Error('Adapter forbidden');
    });
    await new LifecycleService(
      prisma as never,
      { get } as never,
      {} as never,
      {} as never,
    ).reconcile();
    expect(get).not.toHaveBeenCalled();
  });
});
