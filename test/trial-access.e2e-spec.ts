import { Test } from '@nestjs/testing';
import {
  Controller,
  Get,
  UseGuards,
  type INestApplication,
} from '@nestjs/common';
import { TenantGuard, BillingRecovery } from '../src/auth/tenant.guard.js';
import request from 'supertest';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { PaymentsService } from '../src/billing/payments.service.js';
import { ACCESS_COOKIE } from '../src/auth/auth.config.js';
import {
  authDatabase,
  COMPANY_ID,
  OTHER_COMPANY_ID,
} from './support/auth-database.js';
const origin = 'https://dev.kalend.tech';
const deadline = new Date('2026-10-10T12:00:00Z');
const password = 'trial-only-test-password';
@Controller('trial-fixture-product')
@UseGuards(TenantGuard)
@BillingRecovery()
class UnlistedProductController {
  @Get() read() {
    return { product: true };
  }
}
describe('authoritative trial access without scheduler (HTTP, simulated persistence)', () => {
  let app: INestApplication;
  let fixture: ReturnType<typeof authDatabase>;
  let approved = false;
  const checkout = vi.fn(async () => ({
    id: 'pending-payment',
    status: 'PENDING',
  }));
  beforeAll(async () => {
    vi.stubEnv('AUTH_JWT_SECRET', randomBytes(32).toString('hex'));
    vi.stubEnv('AUTH_ALLOWED_ORIGINS', origin);
    fixture = authDatabase(await bcrypt.hash(password, 12));
    const module = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [UnlistedProductController],
    })
      .overrideProvider(PrismaService)
      .useValue(fixture.db)
      .overrideProvider(PaymentsService)
      .useValue({ checkout })
      .compile();
    app = module.createNestApplication({ rawBody: true });
    await app.init();
  });
  beforeEach(() => {
    fixture.reset();
    approved = false;
    checkout.mockClear();
    vi.useFakeTimers({ toFake: ['Date'] });
    fixture.db.subscription.findFirst.mockImplementation((async ({
      where,
    }: {
      where: { companyId: string; OR?: unknown };
    }) => {
      const paid = approved || where.companyId === OTHER_COMPANY_ID;
      const sub = {
        id: where.companyId,
        companyId: where.companyId,
        planId: where.companyId,
        plan: { name: 'Trial fixture' },
        status: paid ? 'ACTIVE' : 'TRIALING',
        trialEndsAt: paid ? null : deadline,
        currentPeriodEnd: paid ? new Date('2027-01-01T00:00:00Z') : null,
        trialStartedAt: new Date(deadline.getTime() - 7 * 86400000),
      };
      return where.OR && !paid && deadline <= new Date() ? null : sub;
    }) as never);
  });
  afterEach(() => vi.useRealTimers());
  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });
  async function login(email = 'member@example.test') {
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .set('Origin', origin)
      .send({ email, password })
      .expect(200);
    const cookies = response.headers['set-cookie'] as unknown as string[];
    return cookies
      .find((value) => value.startsWith(`${ACCESS_COOKIE}=`))!
      .split(';')[0];
  }
  async function select(cookie: string, companyId = COMPANY_ID) {
    await request(app.getHttpServer())
      .post('/auth/tenant')
      .set('Cookie', cookie)
      .set('Origin', origin)
      .send({ companyId })
      .expect(200);
  }
  it.each([-300000, -1000, 0, 1000, 3600000])(
    'checks deadline offset %sms with NO lifecycle invocation',
    async (offset) => {
      vi.setSystemTime(deadline.getTime() + offset);
      const cookie = await login();
      await select(cookie);
      const response = await request(app.getHttpServer())
        .get('/auth/tenant')
        .set('Cookie', cookie)
        .expect(offset < 0 ? 200 : 403);
      if (offset >= 0)
        expect(response.body).toMatchObject({
          code: 'SUBSCRIPTION_REQUIRED',
          accessStatus: 'TRIAL_EXPIRED',
        });
      const state = await request(app.getHttpServer())
        .get('/billing/regularization')
        .set('Cookie', cookie)
        .expect(200);
      expect(state.body.accessAllowed).toBe(offset < 0);
      expect(state.body.accessStatus).toBe(
        offset < 0 ? 'TRIAL_EXPIRING' : 'TRIAL_EXPIRED',
      );
      expect(fixture.memberships[0].company.status).toBe('ACTIVE'); // scheduler never changed company state
      await request(app.getHttpServer())
        .get('/company/communication/evolution/status')
        .set('Cookie', cookie)
        .expect(offset < 0 ? 503 : 403);
      if (offset >= 0) {
        await request(app.getHttpServer())
          .post('/billing/checkout')
          .set('Origin', origin)
          .set('Cookie', cookie)
          .send({})
          .expect(201);
        expect(checkout).toHaveBeenCalledWith(COMPANY_ID, {});
      }
    },
  );
  it('an existing session loses product access immediately, even after constructing a fresh AuthService', async () => {
    vi.setSystemTime(deadline.getTime() - 1000);
    const cookie = await login();
    await select(cookie);
    await request(app.getHttpServer())
      .get('/auth/tenant')
      .set('Cookie', cookie)
      .expect(200);
    vi.setSystemTime(deadline.getTime() + 1000);
    await request(app.getHttpServer())
      .get('/auth/tenant')
      .set('Cookie', cookie)
      .expect(403);
    const { AuthService } = await import('../src/auth/auth.service.js');
    const restarted = new AuthService(
      fixture.db as never,
      {} as never,
      {} as never,
    );
    await expect(
      restarted.membership(fixture.memberships[0].userId, COMPANY_ID),
    ).rejects.toMatchObject({ status: 403 });
  });
  it('restores access after the verified payment state; requests themselves never capture trial events', async () => {
    vi.setSystemTime(deadline.getTime() + 1000);
    const cookie = await login();
    await select(cookie);
    await request(app.getHttpServer())
      .get('/auth/tenant')
      .set('Cookie', cookie)
      .expect(403);
    const transactionsBeforeReads = fixture.db.$transaction.mock.calls.length;
    approved = true; // actual processor/SQL approval is covered by the disposable database flow
    await request(app.getHttpServer())
      .get('/auth/tenant')
      .set('Cookie', cookie)
      .expect(200);
    const state = await request(app.getHttpServer())
      .get('/billing/regularization')
      .set('Cookie', cookie)
      .expect(200);
    expect(state.body).toMatchObject({
      accessAllowed: true,
      accessStatus: 'ACTIVE',
      trial: { expired: false },
    });
    expect(fixture.db.$transaction.mock.calls.length).toBe(
      transactionsBeforeReads,
    );
  });
  it('isolates expired A from paid B and keeps global Super Admin access available', async () => {
    vi.setSystemTime(deadline.getTime() + 3600000);
    const member = await login();
    await select(member);
    await request(app.getHttpServer())
      .get('/auth/tenant')
      .set('Cookie', member)
      .expect(403);
    await select(member, OTHER_COMPANY_ID);
    await request(app.getHttpServer())
      .get('/auth/tenant')
      .set('Cookie', member)
      .expect(200);
    const admin = await login('admin@example.test');
    await request(app.getHttpServer())
      .get('/communication/events')
      .set('Cookie', admin)
      .expect(200);
    const state = await request(app.getHttpServer())
      .get('/billing/regularization')
      .set('Cookie', admin)
      .expect(200);
    expect(state.body.accessStatus).toBe('NOT_APPLICABLE');
  });
  it('recovery metadata cannot expose an unlisted product endpoint after expiry', async () => {
    vi.setSystemTime(deadline.getTime() + 1000);
    const cookie = await login();
    await select(cookie);
    await request(app.getHttpServer())
      .get('/trial-fixture-product')
      .set('Cookie', cookie)
      .expect(403);
    await request(app.getHttpServer())
      .get('/billing/regularization')
      .set('Cookie', cookie)
      .expect(200);
    await request(app.getHttpServer())
      .post('/billing/checkout')
      .set('Cookie', cookie)
      .set('Origin', origin)
      .send({})
      .expect(201);
  });
});
