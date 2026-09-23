import { PrismaService } from '../src/prisma/prisma.service.js';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue({ $queryRaw: async () => [{ value: 1 }] })
      .compile();

    app = moduleFixture.createNestApplication({ rawBody: true });
    await app.init();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });

  it.each([
    '/companies',
    '/users',
    '/subscriptions',
    '/finance',
    '/dashboard/summary',
    '/payment-gateways',
    '/webhooks',
  ])('blocks unauthenticated administration %s', async (path) => {
    await request(app.getHttpServer()).get(path).expect(401);
  });
  it.each(['stripe', 'mercado-pago', 'pagbank'])(
    'does not accept unverified %s webhooks',
    async (gateway) => {
      await request(app.getHttpServer())
        .post(`/webhooks/${gateway}`)
        .send({})
        .expect(503);
    },
  );
  afterEach(async () => {
    await app.close();
  });
});

// Test-only bypass to exercise serializers. Production AdminGuard validates session and global role.
describe('administrative response contracts (mock database)', () => {
  let app: INestApplication<App>;
  beforeEach(async () => {
    const { AdminGuard } = await import('../src/common/admin.guard.js');
    const fixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({
        gatewayConfiguration: {
          findUnique: async () => ({
            enabled: false,
            environment: 'SANDBOX',
            credentialsEncrypted: 'never-return-this',
            webhookSecretEncrypted: 'nor-this',
            status: 'PENDING_VALIDATION',
          }),
        },
      })
      .overrideGuard(AdminGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = fixture.createNestApplication();
    await app.init();
  });
  afterEach(async () => {
    await app.close();
  });
  it('gateway HTTP response contains flags without stored credentials', async () => {
    const response = await request(app.getHttpServer())
      .get('/payment-gateways/STRIPE')
      .expect(200);
    expect(response.body.configured).toBe(true);
    expect(response.body.webhookConfigured).toBe(true);
    expect(JSON.stringify(response.body)).not.toMatch(
      /never-return-this|nor-this|Encrypted|passwordHash/,
    );
  });
  it('rejects an unknown gateway', async () => {
    await request(app.getHttpServer())
      .get('/payment-gateways/UNKNOWN')
      .expect(400);
  });
});
