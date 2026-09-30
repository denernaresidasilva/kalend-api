import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import webpush from 'web-push';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { GoogleApi, GMAIL_SCOPE } from '../src/communication/google-api.js';
import { GMAIL_COOKIE } from '../src/communication/gmail.js';
import { SecretVault } from '../src/billing/secret-vault.js';
import { ACCESS_COOKIE } from '../src/auth/auth.config.js';
import { authDatabase, ADMIN_ID, MEMBER_ID } from './support/auth-database.js';
const origin = 'https://dev.example.test',
  password = 'test-only-password-123';
const vapid = webpush.generateVAPIDKeys(),
  browserKey = webpush.generateVAPIDKeys();
function cookie(response: request.Response, name: string) {
  return (response.headers['set-cookie'] as unknown as string[])
    .find((c) => c.startsWith(name + '='))!
    .split(';')[0];
}
describe('Phase 3 HTTP uses real AuthGuard/AdminGuard, CSRF, JWT and vault with stateful persistence double', () => {
  let app: INestApplication, fixture: ReturnType<typeof authDatabase>;
  const states = new Map<string, any>(),
    devices = new Map<string, any>();
  let provider: Record<string, any>;
  const google = {
    token: vi.fn().mockResolvedValue({
      accessToken: 'ACCESS_PRIVATE',
      refreshToken: 'REFRESH_PRIVATE',
      expiresAt: String(Date.now() + 3600000),
      scope: GMAIL_SCOPE,
    }),
    account: vi.fn().mockResolvedValue('sender@example.test'),
    send: vi.fn().mockResolvedValue('message-id'),
    revoke: vi.fn(),
  };
  beforeAll(async () => {
    vi.stubEnv('AUTH_JWT_SECRET', randomBytes(32).toString('hex'));
    vi.stubEnv('GATEWAY_ENCRYPTION_KEY', randomBytes(32).toString('hex'));
    vi.stubEnv('AUTH_ALLOWED_ORIGINS', origin);
    vi.stubEnv(
      'COMMUNICATION_GMAIL_CALLBACK_URL',
      'https://api.example.test/communication/gmail/callback',
    );
    vi.stubEnv('COMMUNICATION_WEB_PUSH_HOSTS', 'push.example.test');
    fixture = authDatabase(await bcrypt.hash(password, 12));
    Object.assign(fixture.db.user, {
      findFirst: vi.fn(async ({ where }) =>
        fixture.users.find(
          (u) =>
            u.id === where.id &&
            u.isActive &&
            (where.isSuperAdmin !== true || u.isSuperAdmin) &&
            (!where.passwordHash || u.passwordHash === where.passwordHash),
        ),
      ),
    });
    Object.assign(fixture.db.authSession, {
      findFirst: vi.fn(
        async ({ where }) =>
          fixture.sessions
            .map((s) => ({
              ...s,
              user: fixture.users.find((u) => u.id === s.userId)!,
            }))
            .find(
              (s) =>
                s.id === where.id &&
                s.userId === where.userId &&
                !s.revokedAt &&
                s.expiresAt > new Date() &&
                fixture.users.some(
                  (u) => u.id === s.userId && u.isActive && u.isSuperAdmin,
                ),
            ) ?? null,
      ),
    });
    Object.assign(fixture.db, {
      globalGmailOAuthState: {
        create: vi.fn(async ({ data }) =>
          states.set(data.stateHash, { usedAt: null, ...data }),
        ),
        findUnique: vi.fn(
          async ({ where }) => states.get(where.stateHash) ?? null,
        ),
        updateMany: vi.fn(async ({ where, data }) => {
          const s = states.get(where.stateHash);
          if (
            !s ||
            s.usedAt ||
            s.expiresAt <= new Date() ||
            s.bindingHash !== where.bindingHash
          )
            return { count: 0 };
          Object.assign(s, data);
          return { count: 1 };
        }),
        deleteMany: vi.fn(),
      },
      globalCommunicationProvider: {
        findUnique: vi.fn(async ({ where }) =>
          where.provider === 'GMAIL'
            ? provider
            : where.provider === 'PUSH_PENDING'
              ? {
                  enabled: true,
                  scope: 'GLOBAL',
                  status: 'CONNECTED',
                  config: {
                    publicKey: vapid.publicKey,
                    subject: 'mailto:admin@example.test',
                  },
                }
              : null,
        ),
        findMany: vi.fn(async () => [provider]),
        updateMany: vi.fn(async ({ where, data }) => {
          if (provider.revision !== where.revision) return { count: 0 };
          Object.assign(provider, data, {
            revision: data.revision ? provider.revision + 1 : provider.revision,
          });
          return { count: 1 };
        }),
      },
      globalCommunicationLog: { create: vi.fn() },
      globalPushSubscription: {
        findUnique: vi.fn(
          async ({ where }) => devices.get(where.endpointHash) ?? null,
        ),
        count: vi.fn(async () => devices.size),
        upsert: vi.fn(async ({ where, create, update, select }) => {
          const device = devices.get(where.endpointHash) ?? create;
          if (devices.has(where.endpointHash)) Object.assign(device, update);
          devices.set(where.endpointHash, device);
          return Object.fromEntries(
            Object.keys(select).map((k) => [k, device[k]]),
          );
        }),
        findMany: vi.fn(async ({ where, select }) =>
          [...devices.values()]
            .filter((d) => d.userId === where.userId)
            .map((d) =>
              Object.fromEntries(Object.keys(select).map((k) => [k, d[k]])),
            ),
        ),
        updateMany: vi.fn(async ({ where, data }) => {
          const d = [...devices.values()].find(
            (d) => d.id === where.id && d.userId === where.userId,
          );
          if (d) Object.assign(d, data);
          return { count: d ? 1 : 0 };
        }),
      },
    });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(fixture.db)
      .overrideProvider(GoogleApi)
      .useValue(google)
      .compile();
    app = module.createNestApplication({ rawBody: true });
    await app.init();
  });
  beforeEach(() => {
    fixture.reset();
    states.clear();
    devices.clear();
    google.token.mockClear();
    google.send.mockClear();
    provider = {
      provider: 'GMAIL',
      scope: 'GLOBAL',
      environment: 'SANDBOX',
      revision: 1,
      status: 'PENDING_VALIDATION',
      enabled: false,
      config: {
        clientId: '123.apps.googleusercontent.com',
        fromEmail: 'sender@example.test',
      },
      credentialsEncrypted: new SecretVault().encrypt(
        JSON.stringify({ clientSecret: 'CLIENT_PRIVATE' }),
        'communication:GLOBAL:GMAIL:SANDBOX:credentials',
      ),
    };
  });
  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });
  const login = async (email = 'admin@example.test') =>
    cookie(
      await request(app.getHttpServer())
        .post('/auth/login')
        .set('Origin', origin)
        .send({ email, password })
        .expect(200),
      ACCESS_COOKIE,
    );
  const subscribe = (
    auth: string,
    endpoint = 'https://push.example.test/send/one',
    extra = {},
  ) =>
    request(app.getHttpServer())
      .post('/communication/push/subscriptions')
      .set('Cookie', auth)
      .set('Origin', origin)
      .send({
        endpoint,
        keys: {
          p256dh: browserKey.publicKey,
          auth: randomBytes(16).toString('base64url'),
        },
        ...extra,
      });
  it('requires authentication and admin privilege for Gmail configuration/connect/disconnect/status/test', async () => {
    const member = await login('member@example.test');
    for (const path of [
      '/communication/gmail/connect',
      '/communication/gmail/disconnect',
      '/communication/providers/GMAIL/test',
      '/communication/providers/GMAIL/send-test',
    ]) {
      await request(app.getHttpServer())
        .post(path)
        .set('Origin', origin)
        .expect(401);
      await request(app.getHttpServer())
        .post(path)
        .set('Cookie', member)
        .set('Origin', origin)
        .send({})
        .expect(403);
    }
    await request(app.getHttpServer())
      .get('/communication/gmail/status')
      .set('Cookie', member)
      .expect(403);
    await request(app.getHttpServer())
      .patch('/communication/providers/GMAIL')
      .set('Cookie', member)
      .set('Origin', origin)
      .send({})
      .expect(403);
  });
  it('rejects connect CSRF and arbitrary secret/token/redirect inputs', async () => {
    const admin = await login();
    await request(app.getHttpServer())
      .post('/communication/gmail/connect')
      .set('Cookie', admin)
      .expect(403);
    await request(app.getHttpServer())
      .patch('/communication/providers/GMAIL')
      .set('Cookie', admin)
      .set('Origin', origin)
      .send({ secrets: { refreshToken: 'INJECTED' } })
      .expect(400);
    await request(app.getHttpServer())
      .patch('/communication/providers/GMAIL')
      .set('Cookie', admin)
      .set('Origin', origin)
      .send({ redirectUrl: 'https://evil.test' })
      .expect(400);
  });
  it('connects with secure Lax binding cookie; callback needs no access cookie, cannot replay and never leaks tokens/code', async () => {
    const admin = await login();
    const start = await request(app.getHttpServer())
      .post('/communication/gmail/connect')
      .set('Cookie', admin)
      .set('Origin', origin)
      .expect(201);
    const binding = cookie(start, GMAIL_COOKIE),
      state = new URL(start.body.authorizationUrl).searchParams.get('state');
    expect(start.headers['set-cookie'][0]).toContain('HttpOnly');
    expect(start.headers['set-cookie'][0]).toContain('Secure');
    expect(start.headers['set-cookie'][0]).toContain('SameSite=Lax');
    const done = await request(app.getHttpServer())
      .get('/communication/gmail/callback')
      .set('Cookie', binding)
      .query({ state, code: 'AUTHORIZATION_PRIVATE' })
      .expect(200);
    expect(done.headers['referrer-policy']).toBe('no-referrer');
    expect(done.headers['cache-control']).toBe('no-store');
    expect(done.headers['content-security-policy']).toContain(
      "default-src 'none'",
    );
    expect(done.text).not.toMatch(/PRIVATE|state|code/);
    await request(app.getHttpServer())
      .get('/communication/gmail/callback')
      .set('Cookie', binding)
      .query({ state, code: 'AUTHORIZATION_PRIVATE' })
      .expect(400);
    expect(google.token).toHaveBeenCalledTimes(1);
    const status = await request(app.getHttpServer())
      .get('/communication/gmail/status')
      .set('Cookie', admin)
      .expect(200);
    expect(status.body.connected).toBe(true);
    expect(JSON.stringify(status.body)).not.toContain('PRIVATE');
    const providers = await request(app.getHttpServer())
      .get('/communication/providers')
      .set('Cookie', admin)
      .expect(200);
    expect(JSON.stringify(providers.body)).not.toMatch(
      /PRIVATE|credentialsEncrypted/,
    );
    await request(app.getHttpServer())
      .post('/communication/providers/GMAIL/send-test')
      .set('Cookie', admin)
      .set('Origin', origin)
      .send({ to: 'victim@example.test' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/communication/providers/GMAIL/send-test')
      .set('Cookie', admin)
      .set('Origin', origin)
      .send({})
      .expect(201);
    const mime = Buffer.from(
      google.send.mock.calls[0][1],
      'base64url',
    ).toString();
    expect(mime).toContain('To: admin@example.test');
  });
  it('rejects forged callback or missing browser binding before Google exchange', async () => {
    const admin = await login();
    const start = await request(app.getHttpServer())
      .post('/communication/gmail/connect')
      .set('Cookie', admin)
      .set('Origin', origin)
      .expect(201);
    const state = new URL(start.body.authorizationUrl).searchParams.get(
      'state',
    );
    await request(app.getHttpServer())
      .get('/communication/gmail/callback')
      .query({ state, code: 'code' })
      .expect(400);
    expect(google.token).not.toHaveBeenCalled();
  });
  it('rate limits OAuth repeated clicks', async () => {
    const admin = await login();
    for (let i = 0; i < 3; i++)
      await request(app.getHttpServer())
        .post('/communication/gmail/connect')
        .set('Cookie', admin)
        .set('Origin', origin)
        .expect(201);
    await request(app.getHttpServer())
      .post('/communication/gmail/connect')
      .set('Cookie', admin)
      .set('Origin', origin)
      .expect(429);
  });
  it('registers only own devices, protects write Origin and never returns endpoint/auth/private VAPID', async () => {
    const owner = await login('member@example.test');
    await subscribe(owner, undefined, { userId: ADMIN_ID }).expect(400);
    await request(app.getHttpServer())
      .post('/communication/push/subscriptions')
      .set('Cookie', owner)
      .send({})
      .expect(403);
    const first = await subscribe(owner).expect(201);
    const second = await subscribe(
      owner,
      'https://push.example.test/send/two',
    ).expect(201);
    expect(first.body.id).not.toBe(second.body.id);
    expect([...devices.values()].every((d) => d.userId === MEMBER_ID)).toBe(
      true,
    );
    const list = await request(app.getHttpServer())
      .get('/communication/push/subscriptions')
      .set('Cookie', owner)
      .expect(200);
    expect(list.body).toHaveLength(2);
    expect(JSON.stringify(list.body)).not.toMatch(
      /credentials|endpoint|p256dh|auth"/,
    );
    const cfg = await request(app.getHttpServer())
      .get('/communication/push/public-config')
      .set('Cookie', owner)
      .expect(200);
    expect(cfg.body.publicKey).toBe(vapid.publicKey);
    expect(JSON.stringify(cfg.body)).not.toContain(vapid.privateKey);
    const admin = await login();
    await subscribe(admin).expect(409);
    await request(app.getHttpServer())
      .delete(`/communication/push/subscriptions/${first.body.id}`)
      .set('Cookie', admin)
      .set('Origin', origin)
      .expect(200);
    expect([...devices.values()][0].active).toBe(true);
    await request(app.getHttpServer())
      .delete(`/communication/push/subscriptions/${first.body.id}`)
      .set('Cookie', owner)
      .set('Origin', origin)
      .expect(200);
    expect([...devices.values()][0].credentialsEncrypted).toBeNull();
  });
  it('rejects native providers and requires authentication for public Push config', async () => {
    await request(app.getHttpServer())
      .get('/communication/push/public-config')
      .expect(401);
    const owner = await login('member@example.test');
    await subscribe(owner, undefined, {
      provider: 'EXPO',
      platform: 'ANDROID',
    }).expect(400);
    await request(app.getHttpServer())
      .post('/communication/providers/PUSH_PENDING/send-test')
      .set('Cookie', owner)
      .set('Origin', origin)
      .send({})
      .expect(403);
  });
});
