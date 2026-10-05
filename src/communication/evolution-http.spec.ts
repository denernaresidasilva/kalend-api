import { Test } from '@nestjs/testing';
import {
  ForbiddenException,
  type INestApplication,
  UnauthorizedException,
} from '@nestjs/common';
import request from 'supertest';
import {
  CompanyEvolutionController,
  EvolutionWebhookController,
} from './evolution.controller.js';
import { EvolutionService } from './evolution.js';
import { TenantGuard } from '../auth/tenant.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { AuthConfig } from '../auth/auth.config.js';
import { AuthRateLimit } from '../auth/auth-rate-limit.service.js';
describe('Evolution HTTP tenant boundary with real guards', () => {
  let app: INestApplication;
  let role = 'OWNER';
  let selectedCompanyId: string | null = 'company-a';
  let authenticated = true;
  const evolution = {
    get: vi.fn(async (companyId) => ({
      status: 'PENDING',
      companyMarker: companyId,
    })),
    prepare: vi.fn(async () => ({})),
    connect: vi.fn(async () => ({})),
    logout: vi.fn(async () => ({})),
    remove: vi.fn(async () => ({})),
    webhook: vi.fn(async () => {
      throw new UnauthorizedException();
    }),
  };
  beforeAll(async () => {
    vi.stubEnv('AUTH_ALLOWED_ORIGINS', 'https://web.example.test');
    const module = await Test.createTestingModule({
      controllers: [CompanyEvolutionController, EvolutionWebhookController],
      providers: [
        TenantGuard,
        AuthConfig,
        {
          provide: AuthService,
          useValue: {
            authenticate: async () => {
              if (!authenticated) throw new UnauthorizedException();
              return { user: { id: 'user-a' }, session: { selectedCompanyId } };
            },
            membership: async (_userId: string, companyId: string) => {
              if (companyId !== 'company-a') throw new ForbiddenException();
              return { id: 'membership', role };
            },
          },
        },
        { provide: AuthRateLimit, useValue: { consume: async () => {} } },
        { provide: EvolutionService, useValue: evolution },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });
  beforeEach(() => {
    role = 'OWNER';
    selectedCompanyId = 'company-a';
    authenticated = true;
    vi.clearAllMocks();
  });
  it.each(['OWNER', 'ADMIN'])(
    'allows %s and resolves tenant only from authenticated session',
    async (value) => {
      role = value;
      const res = await request(app.getHttpServer()).get(
        '/company/communication/evolution?companyId=company-b&instanceName=other',
      );
      expect(res.status).toBe(200);
      expect(evolution.get).toHaveBeenCalledWith('company-a');
      expect(res.headers['cache-control']).toContain('no-store');
    },
  );
  it.each(['PROFESSIONAL', 'RECEPTIONIST', 'CLIENT'])(
    'rejects %s with 403',
    async (value) => {
      role = value;
      for (const path of ['', '/status'])
        expect(
          (
            await request(app.getHttpServer()).get(
              `/company/communication/evolution${path}`,
            )
          ).status,
        ).toBe(403);
      expect(
        (
          await request(app.getHttpServer())
            .post('/company/communication/evolution/prepare')
            .set('Origin', 'https://web.example.test')
            .send({})
        ).status,
      ).toBe(403);
      expect(evolution.get).not.toHaveBeenCalled();
      expect(evolution.prepare).not.toHaveBeenCalled();
    },
  );
  it('rejects unauthenticated and unauthorized company selection', async () => {
    authenticated = false;
    expect(
      (
        await request(app.getHttpServer()).get(
          '/company/communication/evolution',
        )
      ).status,
    ).toBe(401);
    authenticated = true;
    selectedCompanyId = 'company-b';
    expect(
      (
        await request(app.getHttpServer()).get(
          '/company/communication/evolution',
        )
      ).status,
    ).toBe(403);
    selectedCompanyId = null;
    expect(
      (
        await request(app.getHttpServer()).get(
          '/company/communication/evolution',
        )
      ).status,
    ).toBe(403);
  });
  it('rejects identity injection and requires Origin for mutations', async () => {
    for (const field of ['companyId', 'instanceName', 'connectionId']) {
      expect(
        (
          await request(app.getHttpServer())
            .post('/company/communication/evolution/connect')
            .set('Origin', 'https://web.example.test')
            .send({ [field]: 'other' })
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await request(app.getHttpServer())
          .post('/company/communication/evolution/connect')
          .send({})
      ).status,
    ).toBe(403);
    expect(evolution.connect).not.toHaveBeenCalled();
  });
  it('has no tenant connection identifier route for another company', async () => {
    expect(
      (
        await request(app.getHttpServer()).get(
          '/company/communication/evolution/company-b',
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app.getHttpServer())
          .post('/company/communication/evolution/pairing-code')
          .set('Origin', 'https://web.example.test')
          .send({ phone: '+5511999999999' })
      ).status,
    ).toBe(201);
    expect(evolution.connect).toHaveBeenCalledWith(
      'company-a',
      '+5511999999999',
    );
  });
  it('rejects arbitrary webhooks without authentication', async () => {
    expect(
      (
        await request(app.getHttpServer())
          .post(
            '/webhooks/communication/evolution/11111111-1111-4111-8111-111111111111',
          )
          .send({ event: 'connection.update' })
      ).status,
    ).toBe(401);
  });
});
