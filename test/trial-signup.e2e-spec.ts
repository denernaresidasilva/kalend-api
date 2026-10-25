import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AuthController } from '../src/auth/auth.controller.js';
import { AuthConfig } from '../src/auth/auth.config.js';
import { AuthOriginGuard } from '../src/auth/auth.guard.js';
import { AuthService } from '../src/auth/auth.service.js';

const origin = 'https://dev.kalend.tech';

describe('public trial signup HTTP contract', () => {
  let app: INestApplication;
  const trialSignup = vi.fn();

  beforeAll(async () => {
    const config = {
      origins: () => [origin],
      loginUrl: (requestOrigin?: string) => {
        if (!requestOrigin || requestOrigin !== origin) throw new Error('untrusted origin');
        return new URL('/', requestOrigin).toString();
      },
    };
    const module = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        AuthOriginGuard,
        { provide: AuthConfig, useValue: config },
        { provide: AuthService, useValue: { trialSignup } },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => app.close());
  beforeEach(() => {
    trialSignup.mockReset().mockResolvedValue({
      user: { id: 'user-qa', name: 'Owner QA', email: 'owner@example.test' },
      company: { id: 'company-qa', name: 'Company QA', slug: 'company-qa' },
      subscription: { id: 'trial-qa', status: 'TRIALING' },
    });
  });

  it('creates the trial without issuing cookies, sessions, or tokens', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/trial-signup')
      .set('Origin', origin)
      .send({ email: 'owner@example.test' })
      .expect(201);

    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.body).toMatchObject({ created: true, user: { id: 'user-qa' }, company: { id: 'company-qa' } });
    expect(JSON.stringify(response.body)).not.toMatch(/token|authenticated|password/i);
    expect(trialSignup).toHaveBeenCalledWith({ email: 'owner@example.test' }, expect.any(String), origin);
  });

  it('rejects an arbitrary Origin before creating the account', async () => {
    await request(app.getHttpServer())
      .post('/auth/trial-signup')
      .set('Origin', 'https://attacker.example')
      .send({ email: 'owner@example.test' })
      .expect(403);
    expect(trialSignup).not.toHaveBeenCalled();
  });
});
