import { createRequire } from 'node:module';
import { createECDH, randomBytes } from 'node:crypto';
import webpush from 'web-push';
import {
  GlobalPush,
  pushEndpoint,
  pushKey,
  pushPayload,
  pushScope,
  validateVapid,
} from './push.js';
import { SecretVault } from '../billing/secret-vault.js';
import { secureRequest } from './secure-http.js';
import { TransportFailure } from './contracts.js';
vi.mock('./secure-http.js', () => ({ secureRequest: vi.fn() }));
const network = vi.mocked(secureRequest);
const vapid = webpush.generateVAPIDKeys();
const deviceKey = createECDH('prime256v1');
deviceKey.generateKeys();
const subscription = {
  endpoint: 'https://push.example.test/send/device1',
  keys: {
    p256dh: deviceKey.getPublicKey().toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  },
};
function fixture() {
  const vault = new SecretVault();
  const rows: Record<string, any>[] = [];
  const config = {
    publicKey: vapid.publicKey,
    subject: 'mailto:admin@example.test',
  };
  const db = {
    globalCommunicationProvider: {
      findUnique: vi
        .fn()
        .mockResolvedValue({
          enabled: true,
          scope: 'GLOBAL',
          status: 'CONNECTED',
          config,
        }),
    },
    globalPushSubscription: {
      findUnique: vi.fn(
        async ({ where }) =>
          rows.find((r) => r.endpointHash === where.endpointHash) ?? null,
      ),
      findFirst: vi.fn(
        async ({ where }) =>
          rows.find(
            (r) =>
              r.id === where.id &&
              r.active &&
              (!r.expiresAt || r.expiresAt > new Date()),
          ) ?? null,
      ),
      count: vi.fn(async () => rows.filter((r) => r.active).length),
      findMany: vi.fn(async ({ where, select }) =>
        rows
          .filter((r) => r.userId === where.userId)
          .map((r) =>
            Object.fromEntries(Object.keys(select).map((k) => [k, r[k]])),
          ),
      ),
      upsert: vi.fn(async ({ where, create, update, select }) => {
        let row = rows.find((r) => r.endpointHash === where.endpointHash);
        if (!row) {
          row = {
            provider: 'WEB_PUSH',
            platform: 'WEB',
            scope: 'GLOBAL',
            createdAt: new Date(),
            ...create,
          };
          rows.push(row!);
        } else Object.assign(row, update);
        return Object.fromEntries(Object.keys(select).map((k) => [k, row![k]]));
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        const row = rows.find(
          (r) =>
            r.id === where.id &&
            (!where.userId || where.userId === r.userId) &&
            (!where.credentialsEncrypted ||
              where.credentialsEncrypted === r.credentialsEncrypted),
        );
        if (row) Object.assign(row, data);
        return { count: row ? 1 : 0 };
      }),
    },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation((fn) => fn(db));
  return {
    push: new GlobalPush(db as never, vault),
    db,
    rows,
    vault,
    config,
    secrets: { privateKey: vapid.privateKey },
  };
}
beforeEach(() => {
  vi.stubEnv('GATEWAY_ENCRYPTION_KEY', randomBytes(32).toString('hex'));
  vi.stubEnv('COMMUNICATION_WEB_PUSH_HOSTS', 'push.example.test');
  network.mockReset().mockResolvedValue({ status: 201, body: Buffer.alloc(0) });
});
afterEach(() => vi.unstubAllEnvs());
describe('GLOBAL Web Push devices and transport', () => {
  it('exposes only public VAPID; validates key pair and fails closed without provider', async () => {
    const f = fixture();
    expect(await f.push.publicConfiguration()).toEqual({
      available: true,
      provider: 'WEB_PUSH',
      publicKey: vapid.publicKey,
      nativeAvailable: false,
    });
    expect(JSON.stringify(await f.push.publicConfiguration())).not.toContain(
      vapid.privateKey,
    );
    await f.push.verify(f.config, f.secrets);
    expect(() =>
      validateVapid(f.config, {
        privateKey: webpush.generateVAPIDKeys().privateKey,
      }),
    ).toThrow();
    f.db.globalCommunicationProvider.findUnique.mockResolvedValue(null);
    expect((await f.push.publicConfiguration()).available).toBe(false);
    await expect(f.push.register('owner', subscription)).rejects.toThrow(
      'PUSH_NOT_CONFIGURED',
    );
  });
  it('encrypts endpoint/keys and keeps duplicate subscription stable, with several devices per user', async () => {
    const f = fixture();
    const first = await f.push.register('owner', subscription);
    const same = await f.push.register('owner', {
      ...subscription,
      label: 'Notebook',
    });
    expect(same.id).toBe(first.id);
    const second = await f.push.register('owner', {
      ...subscription,
      endpoint: subscription.endpoint + '2',
    });
    expect(second.id).not.toBe(first.id);
    expect(await f.push.list('owner')).toHaveLength(2);
    const view = JSON.stringify(await f.push.list('owner'));
    expect(view).not.toMatch(/endpoint|credentials|p256dh|auth"/);
    expect(f.rows[0].credentialsEncrypted).not.toContain(subscription.endpoint);
    expect(
      JSON.parse(
        f.vault.decrypt(f.rows[0].credentialsEncrypted, pushScope(first.id)),
      ),
    ).toEqual(subscription);
    expect(() =>
      f.vault.decrypt(
        f.rows[0].credentialsEncrypted,
        `communication:TENANT:push:${first.id}`,
      ),
    ).toThrow();
  });
  it('blocks cross-user subscription hijacking and ignores unauthorized revocation', async () => {
    const f = fixture();
    const first = await f.push.register('owner', subscription);
    await expect(f.push.register('other', subscription)).rejects.toThrow(
      'PUSH_ENDPOINT_UNAVAILABLE',
    );
    await f.push.revoke('other', first.id);
    expect(f.rows[0].active).toBe(true);
    await f.push.revoke('owner', first.id);
    expect(f.rows[0]).toMatchObject({
      active: false,
      credentialsEncrypted: null,
    });
    expect(f.rows[0].revokedAt).toBeInstanceOf(Date);
  });
  it.each(['ANDROID', 'IOS', 'EXPO', 'FCM'])(
    'does not pretend native %s works',
    async (platform) => {
      await expect(
        fixture().push.register('owner', { ...subscription, platform }),
      ).rejects.toThrow('PUSH_TRANSPORT_UNAVAILABLE');
    },
  );
  it('rejects mass assignment, oversized payload, invalid keys and private/arbitrary endpoints', async () => {
    const f = fixture();
    await expect(
      f.push.register('owner', { ...subscription, userId: 'other' }),
    ).rejects.toThrow();
    for (const endpoint of [
      'http://push.example.test/send/1',
      'https://localhost/send/1',
      'https://127.0.0.1/send/1',
      'https://push.example.test.evil.test/send/1',
      'https://u:p@push.example.test/send/1',
      'https://push.example.test:8443/send/1',
      'https://push.example.test/send/1#x',
    ])
      expect(() => pushEndpoint(endpoint)).toThrow();
    expect(() => pushKey('fake', 65)).toThrow();
    expect(() => pushKey(randomBytes(65).toString('base64url'), 65)).toThrow();
    expect(() =>
      pushPayload({ to: 'x', title: 'x', text: 'x'.repeat(3001) }),
    ).toThrow();
    expect(() =>
      pushPayload({ to: 'x', title: 'x\nInjected', text: 'x' }),
    ).toThrow();
    expect(
      JSON.parse(
        pushPayload({ to: 'x', title: 'Olá', text: '<script>x</script>' }),
      ),
    ).toEqual({ version: 1, title: 'Olá', body: '<script>x</script>' });
    await expect(
      f.push.register('owner', { ...subscription, expirationTime: 0 }),
    ).rejects.toThrow();
  });
  it('sends real aes128gcm encrypted payload and VAPID authorization through constrained network', async () => {
    const f = fixture();
    const row = await f.push.register('owner', subscription);
    expect(
      await f.push.send(f.config, f.secrets, {
        to: row.id,
        title: 'Kalend',
        text: 'Pagamento aprovado',
      }),
    ).toMatch(/^webpush:/);
    const [url, method, headers, body] = network.mock.calls[0];
    expect(url.href).toBe(subscription.endpoint);
    expect(method).toBe('POST');
    expect(headers['Content-Encoding']).toBe('aes128gcm');
    expect(headers.Authorization).toMatch(/^vapid t=/);
    expect(body).toBeInstanceOf(Buffer);
    expect(body!.toString()).not.toContain('Pagamento aprovado');
    expect(headers.TTL).toBe(300);
    // Verify generated RFC 8291 record by decrypting the payload with the subscription private key.
    const ece = createRequire(import.meta.url)('http_ece') as {
      decrypt(
        data: Buffer,
        options: {
          version: string;
          privateKey: typeof deviceKey;
          authSecret: Buffer;
        },
      ): Buffer;
    };
    const clear = ece.decrypt(body!, {
      version: 'aes128gcm',
      privateKey: deviceKey,
      authSecret: Buffer.from(subscription.keys.auth, 'base64url'),
    });
    expect(JSON.parse(clear.toString())).toMatchObject({
      title: 'Kalend',
      body: 'Pagamento aprovado',
    });
  });
  it.each([404, 410])(
    'revokes unequivocally invalid subscription HTTP %s and never sends again',
    async (status) => {
      const f = fixture();
      const row = await f.push.register('owner', subscription);
      network.mockResolvedValue({ status, body: Buffer.alloc(0) });
      await expect(
        f.push.send(f.config, f.secrets, { to: row.id, title: 'x', text: 'x' }),
      ).rejects.toMatchObject({ kind: 'RECIPIENT' });
      expect(f.rows[0]).toMatchObject({
        active: false,
        credentialsEncrypted: null,
      });
      await expect(
        f.push.send(f.config, f.secrets, { to: row.id, title: 'x', text: 'x' }),
      ).rejects.toThrow();
      expect(network).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    [429, 'RATE_LIMIT'],
    [503, 'TRANSIENT'],
    [400, 'PERMANENT'],
    [401, 'AUTH'],
  ])('classifies HTTP %s as %s', async (status, kind) => {
    const f = fixture();
    const row = await f.push.register('owner', subscription);
    network.mockResolvedValue({
      status: Number(status),
      body: Buffer.alloc(0),
    });
    await expect(
      f.push.send(f.config, f.secrets, { to: row.id, title: 'x', text: 'x' }),
    ).rejects.toMatchObject({ kind });
    expect(f.rows[0].active).toBe(true);
  });
  it('quarantines timeout, rejects VAPID rotation and expired subscriptions', async () => {
    const f = fixture();
    const row = await f.push.register('owner', subscription);
    network.mockRejectedValue(new TransportFailure('UNCERTAIN'));
    await expect(
      f.push.send(f.config, f.secrets, { to: row.id, title: 'x', text: 'x' }),
    ).rejects.toMatchObject({ kind: 'UNCERTAIN' });
    f.rows[0].vapidPublicKey = webpush.generateVAPIDKeys().publicKey;
    await expect(
      f.push.send(f.config, f.secrets, { to: row.id, title: 'x', text: 'x' }),
    ).rejects.toMatchObject({ kind: 'RECIPIENT' });
    f.rows[0].expiresAt = new Date(0);
    await expect(
      f.push.send(f.config, f.secrets, { to: row.id, title: 'x', text: 'x' }),
    ).rejects.toThrow();
    expect(network).toHaveBeenCalledTimes(1);
  });
});
