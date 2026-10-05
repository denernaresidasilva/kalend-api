
vi.mock('../src/communication/network.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/communication/network.js')>(),
  resolvePublic: vi.fn().mockResolvedValue('8.8.8.8'),
}));
import { Test } from '@nestjs/testing';
import { Logger, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import webpush from 'web-push';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { GlobalPush } from '../src/communication/push.js';
import { CommunicationEngine } from '../src/communication/engine.js';
import { credentialScope } from '../src/communication/configuration.js';
import { TransportFailure } from '../src/communication/contracts.js';
import { secureRequest } from '../src/communication/secure-http.js';
import { SecretVault } from '../src/billing/secret-vault.js';
import { ACCESS_COOKIE } from '../src/auth/auth.config.js';
import {
  authDatabase,
  MEMBER_ID,
  COMPANY_ID,
  OTHER_COMPANY_ID,
} from './support/auth-database.js';
import { pushStore } from './support/push-store.js';

vi.mock('../src/communication/secure-http.js', () => ({
  secureRequest: vi.fn(),
}));
const network = vi.mocked(secureRequest);
const origin = 'https://dev.example.test',
  password = 'fixture-password-only-123';
const vapid = webpush.generateVAPIDKeys(),
  browser = webpush.generateVAPIDKeys();
const subscription = {
  endpoint: 'https://push.example.test/send/device',
  keys: {
    p256dh: browser.publicKey,
    auth: randomBytes(16).toString('base64url'),
  },
};

describe('Phase 4 Push HTTP and existing worker with real authorization/cryptography', () => {
  let app: INestApplication, auth: ReturnType<typeof authDatabase>;
  const store = pushStore();
  let provider: Record<string, any>;
  const outbox = {
    id: '88888888-8888-4888-8888-888888888888',
    scope: 'GLOBAL',
    companyId: COMPANY_ID,
    event: 'PAYMENT_APPROVED',
    variables: { valor: '1.99 BRL' },
    expandedAt: null as Date | null,
  };
  const deliveries: Record<string, any>[] = [];
  const audit = vi.fn();
  const template = {
    id: '99999999-9999-4999-8999-999999999999',
    scope: 'GLOBAL',
    enabled: true,
    channel: 'PUSH',
    provider: 'PUSH_PENDING',
    revision: 1,
    content: {
      title: 'Kalend',
      text: 'Uma atualização para {{empresa}} está disponível.',
    },
  };
  const vault = new SecretVault();
  beforeAll(async () => {
    vi.stubEnv('AUTH_JWT_SECRET', randomBytes(32).toString('hex'));
    vi.stubEnv('GATEWAY_ENCRYPTION_KEY', randomBytes(32).toString('hex'));
    vi.stubEnv('AUTH_ALLOWED_ORIGINS', origin);
    vi.stubEnv('COMMUNICATION_WEB_PUSH_HOSTS', undefined);
    auth = authDatabase(await bcrypt.hash(password, 12));
    const members = (where: Record<string, any>) =>
      auth.memberships
        .filter(
          (m) =>
            (!where.userId || m.userId === where.userId) &&
            (!where.companyId || m.companyId === where.companyId) &&
            (!where.role || m.role === where.role) &&
            m.isActive &&
            auth.users.find((u) => u.id === m.userId)?.isActive,
        )
        .map((m) => ({
          ...m,
          user: auth.users.find((u) => u.id === m.userId)!,
        }));
    Object.assign(auth.db.user, {
      findFirst: vi.fn(
        async ({ where }) =>
          auth.users.find(
            (u) =>
              u.id === where.id &&
              u.isActive &&
              (!where.isSuperAdmin || u.isSuperAdmin),
          ) ?? null,
      ),
    });
    Object.assign(auth.db.membership, {
      findFirst: vi.fn(async ({ where }) => members(where)[0] ?? null),
      findMany: vi.fn(async ({ where }) => members(where)),
    });
    Object.assign(auth.db, store.db, {
      globalCommunicationProvider: {
        findUnique: vi.fn(async () => provider),
        findMany: vi.fn(async () => [provider]),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      globalCommunicationOutbox: {
        findUniqueOrThrow: vi.fn(async () => outbox),
        update: vi.fn(async ({ data }) => Object.assign(outbox, data)),
      },
      globalCommunicationTemplate: {
        findMany: vi.fn(async () => [template]),
        findUnique: vi.fn(async () => template),
      },
      globalCommunicationDelivery: {
        findMany: vi.fn(async () =>
          deliveries
            .filter((d) => ['PENDING', 'RETRY'].includes(d.status))
            .map((d) => ({ ...d })),
        ),
        createMany: vi.fn(async ({ data }) => {
          for (const d of data)
            if (
              !deliveries.some(
                (old) =>
                  old.outboxId === d.outboxId &&
                  old.userId === d.userId &&
                  old.channel === d.channel &&
                  old.targetKey === d.targetKey,
              )
            )
              deliveries.push({ attempts: 0, ...d });
          return { count: data.length };
        }),
        updateMany: vi.fn(async ({ where, data }) => {
          const d = deliveries.find(
            (d) =>
              d.id === where.id &&
              (!where.status || d.status === where.status) &&
              (where.attempts === undefined || d.attempts === where.attempts),
          );
          if (!d) return { count: 0 };
          Object.assign(d, data, {
            attempts: data.attempts?.increment ? d.attempts + 1 : d.attempts,
          });
          return { count: 1 };
        }),
        count: vi.fn(async () => deliveries.length),
      },
      globalCommunicationLog: { create: audit },
      $queryRaw: vi.fn(async () =>
        outbox.expandedAt ? [] : [{ id: outbox.id }],
      ),
    });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(auth.db)
      .compile();
    app = module.createNestApplication({ rawBody: true });
    await app.init();
  });
  beforeEach(() => {
    auth.reset();
    store.reset();
    deliveries.length = 0;
    audit.mockClear();
    outbox.expandedAt = null;
    provider = {
      provider: 'PUSH_PENDING',
      scope: 'GLOBAL',
      environment: 'SANDBOX',
      enabled: true,
      status: 'CONNECTED',
      revision: 1,
      config: {
        subject: 'mailto:admin@example.test',
        publicKey: vapid.publicKey,
      },
      credentialsEncrypted: vault.encrypt(
        JSON.stringify({ privateKey: vapid.privateKey }),
        credentialScope('PUSH_PENDING', 'SANDBOX'),
      ),
    };
    network
      .mockReset()
      .mockResolvedValue({ status: 201, body: Buffer.alloc(0) });
  });
  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });
  const login = async (email = 'member@example.test') => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .set('Origin', origin)
      .send({ email, password })
      .expect(200);
    return (res.headers['set-cookie'] as unknown as string[])
      .find((c) => c.startsWith(ACCESS_COOKIE + '='))!
      .split(';')[0];
  };
  const select = async (cookie: string, companyId = COMPANY_ID) => {
    await request(app.getHttpServer())
      .post('/auth/tenant')
      .set('Cookie', cookie)
      .set('Origin', origin)
      .send({ companyId })
      .expect(200);
  };
  const register = (cookie?: string, input: object = subscription) => {
    const r = request(app.getHttpServer())
      .post('/communication/push/subscriptions')
      .set('Origin', origin)
      .send(input);
    return cookie ? r.set('Cookie', cookie) : r;
  };
  const active = (cookie: string, id: string, value: object) =>
    request(app.getHttpServer())
      .put(`/communication/push/subscriptions/${id}`)
      .set('Cookie', cookie)
      .set('Origin', origin)
      .send(value);
  const list = (cookie: string) =>
    request(app.getHttpServer())
      .get('/communication/push/subscriptions')
      .set('Cookie', cookie);

  it('requires authentication for every device operation and public VAPID contract', async () => {
    await register().expect(401);
    for (const path of [
      '/communication/push/subscriptions',
      '/communication/push/public-config',
    ])
      await request(app.getHttpServer()).get(path).expect(401);
    await request(app.getHttpServer())
      .put(
        '/communication/push/subscriptions/11111111-1111-4111-8111-111111111111',
      )
      .set('Origin', origin)
      .send({ active: false })
      .expect(401);
    await request(app.getHttpServer())
      .delete(
        '/communication/push/subscriptions/11111111-1111-4111-8111-111111111111',
      )
      .set('Origin', origin)
      .expect(401);
  });
  it('requires company selection for ordinary users while returning only public configuration', async () => {
    const cookie = await login();
    await register(cookie).expect(403);
    await list(cookie).expect(403);
    const cfg = await request(app.getHttpServer())
      .get('/communication/push/public-config')
      .set('Cookie', cookie)
      .expect(200);
    expect(cfg.body).toEqual({
      available: true,
      provider: 'WEB_PUSH',
      environment: 'SANDBOX',
      publicKey: vapid.publicKey,
      nativeAvailable: false,
    });
    expect(JSON.stringify(cfg.body)).not.toContain(vapid.privateKey);
  });
  it('registers, updates and deduplicates the selected company without accepting supplied ownership', async () => {
    const cookie = await login();
    await select(cookie);
    const first = await register(cookie).expect(201);
    const again = await register(cookie, {
      ...subscription,
      label: 'Notebook',
    }).expect(201);
    expect(first.body.id).toBe(again.body.id);
    expect(store.devices).toHaveLength(1);
    expect(store.grants).toHaveLength(1);
    expect(store.grants[0]).toMatchObject({
      userId: MEMBER_ID,
      companyId: COMPANY_ID,
    });
    for (const extra of [
      { userId: 'other' },
      { companyId: OTHER_COMPANY_ID },
      { scope: 'TENANT' },
      { secrets: { privateKey: 'fictional' } },
    ])
      await register(cookie, { ...subscription, ...extra }).expect(400);
    const result = await list(cookie).expect(200);
    expect(result.body).toHaveLength(1);
    for (const secret of [
      subscription.endpoint,
      subscription.keys.auth,
      subscription.keys.p256dh,
      vapid.privateKey,
      provider.credentialsEncrypted,
    ])
      expect(JSON.stringify(result.body)).not.toContain(secret);
  });
  it('recovers a paused device by endpoint hash without changing consent or ownership', async () => {
    const cookie = await login();
    await select(cookie);
    const row = await register(cookie).expect(201);
    await request(app.getHttpServer()).put(`/communication/push/subscriptions/${row.body.id}`)
      .set('Cookie', cookie).set('Origin', origin).send({ active: false }).expect(200);
    const hash = row.body.endpointHash;
    const res = await request(app.getHttpServer()).get(`/communication/push/subscriptions?endpointHash=${hash}`)
      .set('Cookie', cookie).expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ id: row.body.id, endpointHash: hash, vapidPublicKey: vapid.publicKey, environment: 'SANDBOX' });
    expect(res.body[0].authorizations[0].active).toBe(false);
    expect(res.body[0]).not.toHaveProperty('registeredInCurrentSession');
    expect(store.grants[0].active).toBe(false);
    await request(app.getHttpServer()).get('/communication/push/subscriptions?endpointHash=invalid').set('Cookie', cookie).expect(400);
    await select(cookie, OTHER_COMPANY_ID);
    const other = await request(app.getHttpServer()).get(`/communication/push/subscriptions?endpointHash=${hash}`).set('Cookie', cookie).expect(200);
    expect(other.body).toEqual([]);
  });
  it('keeps listing and activation isolated when the same user switches companies', async () => {
    const cookie = await login();
    await select(cookie);
    const row = await register(cookie).expect(201);
    await select(cookie, OTHER_COMPANY_ID);
    expect((await list(cookie).expect(200)).body).toHaveLength(0);
    await active(cookie, row.body.id, { active: false }).expect(400);
    expect(store.grants[0].active).toBe(true);
    await register(cookie).expect(201);
    expect(store.devices).toHaveLength(1);
    expect(store.grants).toHaveLength(2);
    await active(cookie, row.body.id, { active: false }).expect(200);
    expect(
      store.grants.find((g) => g.companyId === OTHER_COMPANY_ID)!.active,
    ).toBe(false);
    expect(store.grants.find((g) => g.companyId === COMPANY_ID)!.active).toBe(
      true,
    );
    await active(cookie, row.body.id, { active: true }).expect(200);
  });
  it('enforces Origin on registration, activation and revocation', async () => {
    const cookie = await login();
    await select(cookie);
    const row = await register(cookie).expect(201);
    await request(app.getHttpServer())
      .post('/communication/push/subscriptions')
      .set('Cookie', cookie)
      .send(subscription)
      .expect(403);
    await request(app.getHttpServer())
      .put(`/communication/push/subscriptions/${row.body.id}`)
      .set('Cookie', cookie)
      .send({ active: false })
      .expect(403);
    await request(app.getHttpServer())
      .delete(`/communication/push/subscriptions/${row.body.id}`)
      .set('Cookie', cookie)
      .expect(403);
  });
  it('protects cross-user ownership and revokes idempotently without deleting history', async () => {
    const cookie = await login();
    await select(cookie);
    const row = await register(cookie).expect(201);
    const admin = await login('admin@example.test');
    await register(admin).expect(409);
    await active(admin, row.body.id, { active: false }).expect(400);
    await request(app.getHttpServer())
      .delete(`/communication/push/subscriptions/${row.body.id}`)
      .set('Cookie', admin)
      .set('Origin', origin)
      .expect(200);
    expect(store.devices[0].active).toBe(true);
    for (let i = 0; i < 2; i++)
      await request(app.getHttpServer())
        .delete(`/communication/push/subscriptions/${row.body.id}`)
        .set('Cookie', cookie)
        .set('Origin', origin)
        .expect(200);
    expect(store.devices).toHaveLength(1);
    expect(store.devices[0].credentialsEncrypted).toBeNull();
    expect(store.devices[0].active).toBe(false);
    await active(cookie, row.body.id, { active: true }).expect(400);
  });
  it('validates HTTPS, endpoint size, keys and device metadata with safe HTTP errors', async () => {
    const cookie = await login();
    await select(cookie);
    for (const input of [
      { ...subscription, endpoint: 'http://push.example.test/send/x' },
      { ...subscription, endpoint: 'https://127.0.0.1/send/x' },
      { ...subscription, endpoint: subscription.endpoint + 'x'.repeat(2048) },
      { ...subscription, keys: { auth: 'bad', p256dh: 'bad' } },
      { ...subscription, label: 'x'.repeat(81) },
      { ...subscription, expirationTime: 0 },
      { ...subscription, provider: 'NATIVE_PUSH', platform: 'ANDROID' },
    ]) {
      const res = await register(cookie, input).expect(400);
      expect(JSON.stringify(res.body)).not.toContain(subscription.endpoint);
    }
    expect(store.devices).toHaveLength(0);
  });
  it('rejects a revoked membership even when the authenticated selected-company session remains', async () => {
    const cookie = await login();
    await select(cookie);
    await register(cookie).expect(201);
    auth.memberships[0].isActive = false;
    await register(cookie).expect(403);
    await list(cookie).expect(403);
    expect(network).not.toHaveBeenCalled();
  });
  it('never allows a company owner to modify GLOBAL VAPID, send arbitrary Push or impersonate tenant configuration', async () => {
    const cookie = await login();
    await select(cookie);
    await request(app.getHttpServer())
      .patch('/communication/providers/PUSH_PENDING')
      .set('Cookie', cookie)
      .set('Origin', origin)
      .send({ config: provider.config })
      .expect(403);
    for (const path of [
      '/communication/providers/PUSH_PENDING/test',
      '/communication/providers/PUSH_PENDING/send-test',
    ])
      await request(app.getHttpServer())
        .post(path)
        .set('Cookie', cookie)
        .set('Origin', origin)
        .send({})
        .expect(403);
    await request(app.getHttpServer())
      .post('/communication/push/send')
      .set('Cookie', cookie)
      .set('Origin', origin)
      .send({ to: 'victim' })
      .expect(404);
    expect(network).not.toHaveBeenCalled();
  });
  it('GLOBAL admin send-test is restricted to own devices and refuses arbitrary destinations/scope', async () => {
    const member = await login();
    await select(member);
    await register(member).expect(201);
    const admin = await login('admin@example.test');
    await register(admin, {
      ...subscription,
      endpoint: subscription.endpoint + 'admin',
    }).expect(201);
    for (const input of [
      { to: store.devices[0].id },
      { scope: 'TENANT' },
      { companyId: COMPANY_ID },
    ])
      await request(app.getHttpServer())
        .post('/communication/providers/PUSH_PENDING/send-test')
        .set('Cookie', admin)
        .set('Origin', origin)
        .send(input)
        .expect(400);
    await request(app.getHttpServer())
      .post('/communication/providers/PUSH_PENDING/send-test')
      .set('Cookie', admin)
      .set('Origin', origin)
      .send({})
      .expect(201);
    expect(network).toHaveBeenCalledTimes(1);
    expect(network.mock.calls[0][0].href).toBe(subscription.endpoint + 'admin');
  });
  it('uses CommunicationEngine fanout and durable per-device deduplication without cross-company recipients', async () => {
    const cookie = await login();
    await select(cookie);
    await register(cookie).expect(201);
    await register(cookie, {
      ...subscription,
      endpoint: subscription.endpoint + '2',
      platform: 'ANDROID',
    }).expect(201);
    await select(cookie, OTHER_COMPANY_ID);
    await register(cookie, {
      ...subscription,
      endpoint: subscription.endpoint + 'other',
      platform: 'IOS',
    }).expect(201);
    const engine = app.get(CommunicationEngine);
    await engine.expand();
    await engine.expand();
    expect(deliveries).toHaveLength(2);
    expect(new Set(deliveries.map((d) => d.targetKey)).size).toBe(2);
    await engine.processOne();
    await engine.processOne();
    await engine.processOne();
    expect(deliveries.every((d) => d.status === 'ACCEPTED')).toBe(true);
    expect(network).toHaveBeenCalledTimes(2);
    expect(store.devices.filter((d) => d.lastUsedAt)).toHaveLength(2);
    const logs = JSON.stringify(audit.mock.calls);
    for (const secret of [
      subscription.endpoint,
      subscription.keys.auth,
      subscription.keys.p256dh,
      vapid.privateKey,
      template.content.text,
    ])
      expect(logs).not.toContain(secret);
  });
  it('registers Chrome FCM and dispatches through the existing worker without an allowlist', async () => {
    const cookie = await login();
    await select(cookie);
    const endpoint = 'https://fcm.googleapis.com/fcm/send/test-token';
    const row = await register(cookie, {
      ...subscription, endpoint, provider: 'WEB_PUSH', platform: 'WEB', label: 'Chrome - Linux',
    }).expect(201);
    const result = await list(cookie).expect(200);
    expect(result.body[0]).toMatchObject({ id: row.body.id, active: true });
    const engine = app.get(CommunicationEngine);
    await engine.expand();
    await engine.processOne();
    expect(deliveries[0].status).toBe('ACCEPTED');
    expect(network.mock.calls[0][0].href).toBe(endpoint);
    expect(JSON.stringify(result.body)).not.toContain(endpoint);
    expect(JSON.stringify(result.body)).not.toContain(subscription.keys.auth);
  });
  it('rechecks consent at worker dispatch after outbox expansion', async () => {
    const cookie = await login();
    await select(cookie);
    const row = await register(cookie).expect(201);
    const engine = app.get(CommunicationEngine);
    await engine.expand();
    await active(cookie, row.body.id, { active: false }).expect(200);
    await engine.processOne();
    expect(deliveries[0].status).toBe('SKIPPED');
    expect(network).not.toHaveBeenCalled();
  });
  it.each([404, 410])(
    'deactivates permanent invalid recipient %s through the same worker',
    async (status) => {
      const cookie = await login();
      await select(cookie);
      await register(cookie).expect(201);
      network.mockResolvedValue({ status, body: Buffer.alloc(0) });
      const engine = app.get(CommunicationEngine);
      await engine.expand();
      await engine.processOne();
      await engine.processOne();
      expect(store.devices[0].active).toBe(false);
      expect(store.devices[0].credentialsEncrypted).toBeNull();
      expect(deliveries[0].status).toBe('FAILED');
      expect(network).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    [503, 'RETRY'],
    [429, 'RETRY'],
    [401, 'FAILED'],
    [403, 'FAILED'],
  ])(
    'keeps device on HTTP %s and sets delivery %s',
    async (status, expected) => {
      const cookie = await login();
      await select(cookie);
      await register(cookie).expect(201);
      network.mockResolvedValue({
        status: Number(status),
        body: Buffer.alloc(0),
      });
      const engine = app.get(CommunicationEngine);
      await engine.expand();
      await engine.processOne();
      expect(deliveries[0].status).toBe(expected);
      expect(store.devices[0].active).toBe(true);
      expect(store.devices[0].credentialsEncrypted).toBeTruthy();
    },
  );
  it('quarantines timeout instead of deleting subscription or repeating an uncertain delivery', async () => {
    const cookie = await login();
    await select(cookie);
    await register(cookie).expect(201);
    network.mockRejectedValue(new TransportFailure('UNCERTAIN'));
    const engine = app.get(CommunicationEngine);
    await engine.expand();
    await engine.processOne();
    await engine.processOne();
    expect(deliveries[0].status).toBe('UNCERTAIN');
    expect(store.devices[0].active).toBe(true);
    expect(network).toHaveBeenCalledTimes(1);
  });
  it('records UNSENDABLE when an authorized owner has no subscription', async () => {
    const engine = app.get(CommunicationEngine);
    await engine.expand();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].status).toBe('UNSENDABLE');
    expect(network).not.toHaveBeenCalled();
  });
  it('does not log secrets from unexpected send-test provider errors', async () => {
    const admin = await login('admin@example.test');
    await register(admin).expect(201);
    const error = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    try {
      network.mockRejectedValue(
        new Error(
          JSON.stringify({ ...subscription, privateKey: vapid.privateKey }),
        ),
      );
      const res = await request(app.getHttpServer())
        .post('/communication/providers/PUSH_PENDING/send-test')
        .set('Cookie', admin)
        .set('Origin', origin)
        .send({})
        .expect(503);
      const exposed = JSON.stringify({
        response: res.body,
        audit: audit.mock.calls,
        logs: error.mock.calls,
      });
      for (const secret of [
        subscription.endpoint,
        subscription.keys.auth,
        subscription.keys.p256dh,
        vapid.privateKey,
      ])
        expect(exposed).not.toContain(secret);
    } finally {
      error.mockRestore();
    }
  });
  it('public provider availability never falls back to a non-GLOBAL configuration', async () => {
    const cookie = await login();
    provider.scope = 'TENANT';
    const result = await request(app.getHttpServer())
      .get('/communication/push/public-config')
      .set('Cookie', cookie)
      .expect(200);
    expect(result.body.available).toBe(false);
    expect(result.body.publicKey).toBeNull();
    expect(app.get(GlobalPush)).toBeDefined();
  });
});
