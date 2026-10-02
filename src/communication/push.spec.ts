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
import { Logger } from '@nestjs/common';
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
  const grants: Record<string, any>[] = [];
  const config = {
    publicKey: vapid.publicKey,
    subject: 'mailto:admin@example.test',
  };
  const matches = (r: Record<string, any>, w: Record<string, any>) =>
    (!w.id || r.id === w.id) &&
    (!w.userId || r.userId === w.userId) &&
    (!w.environment || r.environment === w.environment) &&
    (!w.provider || r.provider === w.provider) &&
    (!w.scope || r.scope === w.scope) &&
    (!w.credentialsEncrypted?.not ||
      r.credentialsEncrypted !== w.credentialsEncrypted.not) &&
    (!w.expiresAt?.lte || (r.expiresAt && r.expiresAt <= w.expiresAt.lte)) &&
    (w.active === undefined || r.active === w.active) &&
    (w.revokedAt !== null || !r.revokedAt) &&
    (!w.OR || !r.expiresAt || r.expiresAt > new Date()) &&
    (!w.authorizations ||
      grants.some(
        (g) =>
          g.subscriptionId === r.id &&
          g.companyId === w.authorizations.some.companyId &&
          (w.authorizations.some.active === undefined ||
            g.active === w.authorizations.some.active) &&
          (w.authorizations.some.revokedAt !== null || !g.revokedAt),
      ));
  const db = {
    user: { findFirst: vi.fn().mockResolvedValue({ isSuperAdmin: true }) },
    membership: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ isActive: true, company: { isActive: true } }),
    },
    globalPushAuthorization: {
      upsert: vi.fn(async ({ where, create, update }) => {
        let g = grants.find(
          (g) =>
            g.subscriptionId ===
              where.subscriptionId_companyId.subscriptionId &&
            g.companyId === where.subscriptionId_companyId.companyId,
        );
        if (g) Object.assign(g, update);
        else {
          g = { active: true, revokedAt: null, ...create };
          grants.push(g!);
        }
        return g;
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        const g = grants.find(
          (g) =>
            g.subscriptionId === where.subscriptionId &&
            g.userId === where.userId &&
            g.companyId === where.companyId,
        );
        if (g) Object.assign(g, data);
        return { count: g ? 1 : 0 };
      }),
    },
    globalCommunicationProvider: {
      findUnique: vi.fn().mockResolvedValue({
        enabled: true,
        environment: 'SANDBOX',
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
      findFirst: vi.fn(async ({ where }) => {
        const row = rows.find((r) => matches(r, where));
        return row ? { ...row } : null;
      }),
      count: vi.fn(
        async ({ where }: { where: any }) =>
          rows.filter((r) => matches(r, where)).length,
      ),
      findMany: vi.fn(async ({ where, select }) =>
        rows
          .filter((r) => matches(r, where))
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
            matches(r, where) &&
            (typeof where.credentialsEncrypted !== 'string' ||
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
    grants,
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

describe('Phase 4 tenant authorization and device lifecycle', () => {
  const recipient = {
    userId: 'owner',
    companyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    environment: 'SANDBOX',
    audience: 'COMPANY',
  } as const;
  const message = (id: string) => ({
    to: id,
    title: 'Kalend',
    text: 'Uma atualização está disponível.',
    pushRecipient: recipient,
  });

  it('requires a selected company for ordinary users and checks active membership', async () => {
    const f = fixture();
    f.db.user.findFirst.mockResolvedValue({ isSuperAdmin: false });
    await expect(f.push.register('owner', subscription)).rejects.toThrow(
      'PUSH_COMPANY_REQUIRED',
    );
    await expect(f.push.list('owner')).rejects.toThrow('PUSH_COMPANY_REQUIRED');
    await f.push.register(
      'owner',
      subscription,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    f.db.membership.findUnique.mockResolvedValue({
      isActive: false,
      company: { isActive: true },
    });
    await expect(
      f.push.list('owner', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    ).rejects.toThrow('PUSH_COMPANY_UNAUTHORIZED');
  });
  it('does not auto-enroll legacy/global devices for company notifications', async () => {
    const f = fixture();
    const row = await f.push.register('owner', subscription);
    await expect(
      f.push.send(f.config, f.secrets, message(row.id)),
    ).rejects.toMatchObject({ kind: 'RECIPIENT' });
    expect(network).not.toHaveBeenCalled();
  });
  it('keeps a single endpoint with independently idempotent consent for several companies', async () => {
    const f = fixture();
    const a = await f.push.register(
      'owner',
      subscription,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    const b = await f.push.register(
      'owner',
      { ...subscription, label: 'Mobile', platform: 'ANDROID' },
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    );
    await f.push.register(
      'owner',
      subscription,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    expect(a.id).toBe(b.id);
    expect(f.rows).toHaveLength(1);
    expect(f.grants).toHaveLength(2);
    expect(
      await f.push.list('owner', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    ).toHaveLength(1);
    expect(
      await f.push.list('owner', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
    ).toHaveLength(0);
    expect(
      await f.push.list('other', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    ).toHaveLength(0);
  });
  it('updates device keys without changing ownership, ID or creating another device', async () => {
    const f = fixture();
    const first = await f.push.register(
      'owner',
      subscription,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    const newAuth = randomBytes(16).toString('base64url');
    await f.push.register(
      'owner',
      { ...subscription, keys: { ...subscription.keys, auth: newAuth } },
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    expect(f.rows[0].id).toBe(first.id);
    expect(
      JSON.parse(
        f.vault.decrypt(f.rows[0].credentialsEncrypted, pushScope(first.id)),
      ).keys.auth,
    ).toBe(newAuth);
    expect(f.rows).toHaveLength(1);
  });
  it('pauses only selected-company consent and resumes it idempotently', async () => {
    const f = fixture();
    const row = await f.push.register(
      'owner',
      subscription,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    await f.push.register(
      'owner',
      subscription,
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    );
    await f.push.setActive(
      'owner',
      row.id,
      { active: false },
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    await expect(
      f.push.send(f.config, f.secrets, message(row.id)),
    ).rejects.toMatchObject({ kind: 'RECIPIENT' });
    await f.push.send(f.config, f.secrets, {
      ...message(row.id),
      pushRecipient: {
        ...recipient,
        companyId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      },
    });
    await f.push.setActive(
      'owner',
      row.id,
      { active: true },
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    await f.push.setActive(
      'owner',
      row.id,
      { active: true },
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    await f.push.send(f.config, f.secrets, message(row.id));
    expect(f.grants).toHaveLength(2);
    expect(network).toHaveBeenCalledTimes(2);
  });
  it('rejects activation in an unrelated company and cross-user device access', async () => {
    const f = fixture();
    const row = await f.push.register(
      'owner',
      subscription,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    await expect(
      f.push.setActive(
        'owner',
        row.id,
        { active: false },
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      ),
    ).rejects.toThrow('PUSH_DEVICE_UNAVAILABLE');
    await expect(
      f.push.setActive(
        'other',
        row.id,
        { active: false },
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      ),
    ).rejects.toThrow('PUSH_DEVICE_UNAVAILABLE');
    await f.push.revoke(
      'owner',
      row.id,
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    );
    expect(f.rows[0].active).toBe(true);
  });
  it('revokes the device without deleting its history and requires re-registration to restore credentials', async () => {
    const f = fixture();
    const row = await f.push.register(
      'owner',
      subscription,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    await f.push.revoke(
      'owner',
      row.id,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    await f.push.revoke(
      'owner',
      row.id,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    expect(f.rows).toHaveLength(1);
    expect(f.rows[0].credentialsEncrypted).toBeNull();
    await expect(
      f.push.setActive(
        'owner',
        row.id,
        { active: true },
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      ),
    ).rejects.toThrow('PUSH_DEVICE_UNAVAILABLE');
    expect(
      (
        await f.push.register(
          'owner',
          subscription,
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        )
      ).id,
    ).toBe(row.id);
  });
  it('fans out to authorized devices, continues after failure and returns only aggregate codes', async () => {
    const f = fixture();
    await f.push.register(
      'owner',
      subscription,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    await f.push.register(
      'owner',
      {
        ...subscription,
        endpoint: subscription.endpoint + '2',
        platform: 'IOS',
      },
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    await f.push.register(
      'other',
      { ...subscription, endpoint: subscription.endpoint + '3' },
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    await f.push.register(
      'owner',
      { ...subscription, endpoint: subscription.endpoint + '4' },
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    );
    network.mockResolvedValueOnce({ status: 410, body: Buffer.alloc(0) });
    const result = await f.push.sendToUser(f.config, f.secrets, recipient, {
      title: 'Kalend',
      text: 'Atualização',
    });
    expect(result).toEqual({
      total: 2,
      accepted: 1,
      failed: 1,
      failures: { RECIPIENT: 1 },
    });
    expect(network).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toMatch(
      /endpoint|keys|privateKey|subscriptionId|payload/,
    );
  });
  it('returns an empty aggregate for a user without devices', async () => {
    const f = fixture();
    expect(
      await f.push.sendToUser(f.config, f.secrets, recipient, {
        title: 'x',
        text: 'x',
      }),
    ).toEqual({ total: 0, accepted: 0, failed: 0, failures: {} });
  });
  it.each([
    'wrong-user',
    'wrong-company',
    'wrong-environment',
    'missing-context',
  ])('rejects unauthorized individual target: %s', async (condition) => {
    const f = fixture();
    const row = await f.push.register(
      'owner',
      subscription,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    const context =
      condition === 'wrong-user'
        ? { ...recipient, userId: 'other' }
        : condition === 'wrong-company'
          ? { ...recipient, companyId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }
          : condition === 'wrong-environment'
            ? { ...recipient, environment: 'PRODUCTION' as const }
            : undefined;
    await expect(
      f.push.send(f.config, f.secrets, {
        ...message(row.id),
        pushRecipient: context,
      }),
    ).rejects.toMatchObject({ kind: 'RECIPIENT' });
    expect(network).not.toHaveBeenCalled();
  });
  it('refuses endpoint reassignment across environments even with the same VAPID key', async () => {
    const f = fixture();
    await f.push.register(
      'owner',
      subscription,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    f.db.globalCommunicationProvider.findUnique.mockResolvedValue({
      enabled: true,
      environment: 'PRODUCTION',
      scope: 'GLOBAL',
      status: 'CONNECTED',
      config: f.config,
    } as never);
    await expect(
      f.push.register(
        'owner',
        subscription,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      ),
    ).rejects.toThrow('PUSH_ENVIRONMENT_CHANGED');
  });
  it('sanitizes unexpected provider exceptions and does not revoke on uncertain failure', async () => {
    const f = fixture();
    const row = await f.push.register(
      'owner',
      subscription,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    const log = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    try {
      network.mockRejectedValue(
        new Error(
          JSON.stringify({
            ...subscription,
            privateKey: vapid.privateKey,
            text: 'SENSITIVE_PAYLOAD',
          }),
        ),
      );
      const result = await f.push.sendToUser(f.config, f.secrets, recipient, {
        title: 'x',
        text: 'SENSITIVE_PAYLOAD',
      });
      expect(result.failures).toEqual({ UNCERTAIN: 1 });
      expect(f.rows[0].active).toBe(true);
      expect(f.rows[0].credentialsEncrypted).toBeTruthy();
      expect(log).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain(subscription.endpoint);
      expect(row.id).toBeTruthy();
    } finally {
      log.mockRestore();
    }
  });
  it('records last acceptance without claiming browser delivery or reading', async () => {
    const f = fixture();
    const row = await f.push.register(
      'owner',
      subscription,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    await f.push.send(f.config, f.secrets, message(row.id));
    expect(f.rows[0].lastUsedAt).toBeInstanceOf(Date);
  });
  it('preserves an opaque query on an allowlisted HTTPS push endpoint', async () => {
    const f = fixture();
    const endpoint = subscription.endpoint + '?opaque=fixture-only';
    const row = await f.push.register(
      'owner',
      { ...subscription, endpoint },
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    await f.push.send(f.config, f.secrets, message(row.id));
    expect(network.mock.calls[0][0].href).toBe(endpoint);
  });
  it('quarantines a failure to persist metadata after provider acceptance', async () => {
    const f = fixture();
    const row = await f.push.register(
      'owner',
      subscription,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    f.db.globalPushSubscription.updateMany.mockRejectedValueOnce(
      new Error('private-database-error'),
    );
    await expect(
      f.push.send(f.config, f.secrets, message(row.id)),
    ).rejects.toMatchObject({ kind: 'UNCERTAIN' });
    expect(network).toHaveBeenCalledTimes(1);
    expect(f.rows[0].active).toBe(true);
  });
  it('deactivates malformed authenticated subscription storage but preserves devices when the vault is unavailable', async () => {
    const f = fixture();
    const row = await f.push.register(
      'owner',
      subscription,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    f.rows[0].credentialsEncrypted = f.vault.encrypt(
      JSON.stringify({
        ...subscription,
        keys: { p256dh: 'invalid', auth: 'invalid' },
      }),
      pushScope(row.id),
    );
    await expect(
      f.push.send(f.config, f.secrets, message(row.id)),
    ).rejects.toMatchObject({ kind: 'RECIPIENT' });
    expect(f.rows[0].active).toBe(false);
    expect(f.rows[0].credentialsEncrypted).toBeNull();
    await f.push.register(
      'owner',
      subscription,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    vi.stubEnv('GATEWAY_ENCRYPTION_KEY', '');
    await expect(
      f.push.send(f.config, f.secrets, message(row.id)),
    ).rejects.toMatchObject({ kind: 'PERMANENT' });
    expect(f.rows[0].active).toBe(true);
    expect(network).not.toHaveBeenCalled();
  });
  it('allows opted-in suspended billing recovery but rejects inactive unrelated companies', async () => {
    const f = fixture();
    f.db.membership.findUnique.mockResolvedValue({
      isActive: true,
      company: { isActive: false, status: 'SUSPENDED' },
    } as never);
    const row = await f.push.register(
      'owner',
      subscription,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    await f.push.send(f.config, f.secrets, message(row.id));
    f.db.membership.findUnique.mockResolvedValue({
      isActive: true,
      company: { isActive: false, status: 'ACTIVE' },
    } as never);
    await expect(
      f.push.send(f.config, f.secrets, message(row.id)),
    ).rejects.toMatchObject({ kind: 'RECIPIENT' });
    expect(network).toHaveBeenCalledTimes(1);
  });
  it('requires live Super Admin for internal global test fanout and rejects missing tenant context', async () => {
    const f = fixture();
    f.db.user.findFirst.mockResolvedValue({ isSuperAdmin: false });
    await expect(
      f.push.sendToUser(
        f.config,
        f.secrets,
        { userId: 'owner', environment: 'SANDBOX', audience: 'ADMIN_TEST' },
        { title: 'x', text: 'x' },
      ),
    ).rejects.toThrow();
    await expect(
      f.push.sendToUser(
        f.config,
        f.secrets,
        { userId: 'owner', environment: 'SANDBOX', audience: 'COMPANY' },
        { title: 'x', text: 'x' },
      ),
    ).rejects.toThrow();
    expect(network).not.toHaveBeenCalled();
  });
  it('includes only version/title/body in the browser payload, omitting recipient context and extraneous secrets', () => {
    const payload = JSON.parse(
      pushPayload({
        to: 'private-device-id',
        title: 'Kalend',
        text: 'Uma atualização',
        pushRecipient: recipient,
        ...({
          endpoint: subscription.endpoint,
          keys: subscription.keys,
          privateKey: vapid.privateKey,
        } as object),
      }),
    );
    expect(payload).toEqual({
      version: 1,
      url: '/conta/notificacoes',
      title: 'Kalend',
      body: 'Uma atualização',
    });
    expect(JSON.stringify(payload)).not.toMatch(
      /private|company|endpoint|p256dh|auth/,
    );
  });
  it('does not revoke a newly registered snapshot when an old request returns 410', async () => {
    const f = fixture();
    const row = await f.push.register(
      'owner',
      subscription,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    network.mockImplementationOnce(async () => {
      await f.push.register(
        'owner',
        subscription,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      );
      return { status: 410, body: Buffer.alloc(0) };
    });
    await expect(
      f.push.send(f.config, f.secrets, message(row.id)),
    ).rejects.toMatchObject({ kind: 'RECIPIENT' });
    expect(f.rows[0].active).toBe(true);
    expect(f.rows[0].credentialsEncrypted).toBeTruthy();
  });
  it('expires devices through cleanup without deleting metadata', async () => {
    const f = fixture();
    await f.push.register(
      'owner',
      subscription,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    f.rows[0].expiresAt = new Date(0);
    await f.push.cleanup();
    expect(f.rows[0].active).toBe(false);
    expect(f.rows[0].credentialsEncrypted).toBeNull();
    expect(f.rows).toHaveLength(1);
  });
  it('rejects tenant/provider mass assignment and native registration', async () => {
    const f = fixture();
    for (const extra of [
      { scope: 'TENANT' },
      { companyId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
      { provider: 'NATIVE_PUSH', platform: 'ANDROID' },
    ])
      await expect(
        f.push.register(
          'owner',
          { ...subscription, ...extra },
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        ),
      ).rejects.toThrow();
  });
});
afterEach(() => vi.unstubAllEnvs());
describe('GLOBAL Web Push devices and transport', () => {
  it('exposes only public VAPID; validates key pair and fails closed without provider', async () => {
    const f = fixture();
    expect(await f.push.publicConfiguration()).toEqual({
      available: true,
      provider: 'WEB_PUSH',
      publicKey: vapid.publicKey,
      environment: 'SANDBOX',
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
  it.each(['EXPO', 'FCM', 'APNS'])(
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
    ).toEqual({ version: 1, title: 'Olá', body: '<script>x</script>', url: '/conta/notificacoes' });
    await expect(
      f.push.register('owner', { ...subscription, expirationTime: 0 }),
    ).rejects.toThrow();
  });
  it('sends real aes128gcm encrypted payload and VAPID authorization through constrained network', async () => {
    const f = fixture();
    const row = await f.push.register('owner', subscription);
    expect(
      await f.push.send(f.config, f.secrets, {
        pushRecipient: {
          userId: 'owner',
          environment: 'SANDBOX',
          audience: 'ADMIN_TEST',
        },
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
        f.push.send(f.config, f.secrets, {
          pushRecipient: {
            userId: 'owner',
            environment: 'SANDBOX',
            audience: 'ADMIN_TEST',
          },
          to: row.id,
          title: 'x',
          text: 'x',
        }),
      ).rejects.toMatchObject({ kind: 'RECIPIENT' });
      expect(f.rows[0]).toMatchObject({
        active: false,
        credentialsEncrypted: null,
      });
      await expect(
        f.push.send(f.config, f.secrets, {
          pushRecipient: {
            userId: 'owner',
            environment: 'SANDBOX',
            audience: 'ADMIN_TEST',
          },
          to: row.id,
          title: 'x',
          text: 'x',
        }),
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
      f.push.send(f.config, f.secrets, {
        pushRecipient: {
          userId: 'owner',
          environment: 'SANDBOX',
          audience: 'ADMIN_TEST',
        },
        to: row.id,
        title: 'x',
        text: 'x',
      }),
    ).rejects.toMatchObject({ kind });
    expect(f.rows[0].active).toBe(true);
  });
  it('quarantines timeout, rejects VAPID rotation and expired subscriptions', async () => {
    const f = fixture();
    const row = await f.push.register('owner', subscription);
    network.mockRejectedValue(new TransportFailure('UNCERTAIN'));
    await expect(
      f.push.send(f.config, f.secrets, {
        pushRecipient: {
          userId: 'owner',
          environment: 'SANDBOX',
          audience: 'ADMIN_TEST',
        },
        to: row.id,
        title: 'x',
        text: 'x',
      }),
    ).rejects.toMatchObject({ kind: 'UNCERTAIN' });
    f.rows[0].vapidPublicKey = webpush.generateVAPIDKeys().publicKey;
    await expect(
      f.push.send(f.config, f.secrets, {
        pushRecipient: {
          userId: 'owner',
          environment: 'SANDBOX',
          audience: 'ADMIN_TEST',
        },
        to: row.id,
        title: 'x',
        text: 'x',
      }),
    ).rejects.toMatchObject({ kind: 'RECIPIENT' });
    f.rows[0].expiresAt = new Date(0);
    await expect(
      f.push.send(f.config, f.secrets, {
        pushRecipient: {
          userId: 'owner',
          environment: 'SANDBOX',
          audience: 'ADMIN_TEST',
        },
        to: row.id,
        title: 'x',
        text: 'x',
      }),
    ).rejects.toThrow();
    expect(network).toHaveBeenCalledTimes(1);
  });
});

describe('Scope and active-device quota regressions', () => {
  it.each(['', ' ', 'not-a-uuid'])(
    'rejects malformed company context before database access: %j',
    async (companyId) => {
      const f = fixture();
      const recipient = {
        userId: 'owner',
        environment: 'SANDBOX',
        audience: 'COMPANY',
        companyId,
      } as const;
      await expect(
        f.push.send(f.config, f.secrets, {
          to: 'device',
          title: 'x',
          text: 'x',
          pushRecipient: recipient,
        }),
      ).rejects.toMatchObject({ kind: 'RECIPIENT' });
      await expect(
        f.push.sendToUser(f.config, f.secrets, recipient, {
          title: 'x',
          text: 'x',
        }),
      ).rejects.toMatchObject({ kind: 'RECIPIENT' });
      await expect(
        f.push.register('owner', subscription, companyId),
      ).rejects.toThrow('PUSH_SCOPE_INVALID');
      await expect(f.push.list('owner', companyId)).rejects.toThrow(
        'PUSH_SCOPE_INVALID',
      );
      await expect(f.push.revoke('owner', 'device', companyId)).rejects.toThrow(
        'PUSH_SCOPE_INVALID',
      );
      await expect(
        f.push.setActive('owner', 'device', { active: true }, companyId),
      ).rejects.toThrow('PUSH_SCOPE_INVALID');
      expect(f.db.user.findFirst).not.toHaveBeenCalled();
      expect(network).not.toHaveBeenCalled();
    },
  );
  it('enforces quota on reactivation and permits idempotent activation', async () => {
    const f = fixture();
    const paused = await f.push.register('owner', subscription);
    await f.push.setActive('owner', paused.id, { active: false });
    for (let i = 0; i < 20; i++)
      await f.push.register('owner', {
        ...subscription,
        endpoint: `https://push.example.test/send/quota${i}`,
      });
    await expect(
      f.push.setActive('owner', paused.id, { active: true }),
    ).rejects.toThrow('PUSH_DEVICE_LIMIT');
    expect(f.rows[0].active).toBe(false);
    await expect(
      f.push.register('owner', {
        ...subscription,
        endpoint: 'https://push.example.test/send/overflow',
      }),
    ).rejects.toThrow('PUSH_DEVICE_LIMIT');
    await f.push.setActive('owner', f.rows[1].id, { active: true });
    await f.push.setActive('owner', f.rows[1].id, { active: false });
    await f.push.setActive('owner', paused.id, { active: true });
    expect(f.rows.filter((r) => r.active)).toHaveLength(20);
  });
  it('counts expired-device re-registration as an additional active device', async () => {
    const f = fixture();
    await f.push.register('owner', subscription);
    f.rows[0].expiresAt = new Date(0);
    for (let i = 0; i < 20; i++)
      await f.push.register('owner', {
        ...subscription,
        endpoint: `https://push.example.test/send/live${i}`,
      });
    await expect(f.push.register('owner', subscription)).rejects.toThrow(
      'PUSH_DEVICE_LIMIT',
    );
    expect(f.rows[0].expiresAt).toEqual(new Date(0));
  });
});
