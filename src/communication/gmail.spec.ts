import { credentialHash } from '../auth/auth.tokens.js';
import { randomBytes } from 'node:crypto';
import { GmailTransport, gmailRedirectUri, oauthHash } from './gmail.js';
import { SecretVault } from '../billing/secret-vault.js';
import { TransportFailure } from './contracts.js';
import { GMAIL_SCOPE, GOOGLE_EMAIL_SCOPE } from './google-api.js';
import { CommunicationConfiguration } from './configuration.js';
function fixture() {
  const vault = new SecretVault();
  const config = {
    clientId: '123.apps.googleusercontent.com',
    fromEmail: 'sender@example.test',
  };
  const scope = 'communication:GLOBAL:GMAIL:SANDBOX:credentials';
  const row = {
    provider: 'GMAIL',
    scope: 'GLOBAL',
    config,
    environment: 'SANDBOX',
    revision: 1,
    enabled: false,
    status: 'PENDING_VALIDATION',
    lastError: null as string | null,
    credentialsEncrypted: vault.encrypt(
      JSON.stringify({ clientSecret: 'CLIENT_SECRET' }),
      scope,
    ),
  };
  const states = new Map<string, Record<string, any>>();
  const db = {
    globalCommunicationProvider: {
      findUnique: vi.fn(async () => row),
      findMany: vi.fn(async () => [row]),
      updateMany: vi.fn(async ({ where, data }) => {
        if (
          where.revision !== row.revision ||
          (where.credentialsEncrypted &&
            where.credentialsEncrypted !== row.credentialsEncrypted)
        )
          return { count: 0 };
        Object.assign(row, data, {
          revision: data.revision ? row.revision + 1 : row.revision,
        });
        return { count: 1 };
      }),
    },
    globalGmailOAuthState: {
      create: vi.fn(async ({ data }) => {
        states.set(data.stateHash, { usedAt: null, ...data });
      }),
      findUnique: vi.fn(
        async ({ where }) => states.get(where.stateHash) ?? null,
      ),
      updateMany: vi.fn(async ({ where, data }) => {
        const state = states.get(where.stateHash);
        if (!state || state.usedAt || state.expiresAt <= new Date())
          return { count: 0 };
        Object.assign(state, data);
        return { count: 1 };
      }),
      deleteMany: vi.fn(),
    },
    authSession: {
      findFirst: vi
        .fn()
        .mockResolvedValue({
          id: 'session',
          credentialHash: credentialHash('HASH'),
          user: { passwordHash: 'HASH' },
        }),
    },
    globalCommunicationLog: { create: vi.fn() },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation((fn) => fn(db));
  const google = {
    token: vi.fn().mockResolvedValue({
      accessToken: 'ACCESS_TOKEN',
      refreshToken: 'REFRESH_TOKEN',
      expiresAt: String(Date.now() + 3600000),
      scope: `${GMAIL_SCOPE} ${GOOGLE_EMAIL_SCOPE}`,
    }),
    account: vi.fn().mockResolvedValue('sender@example.test'),
    send: vi.fn().mockResolvedValue('message-id'),
    revoke: vi.fn(),
  };
  const gmail = new GmailTransport(db as never, vault, google as never);
  const identity = {
    user: { id: 'admin' },
    session: { id: 'session' },
  } as never;
  const connect = async () => {
    const result = await gmail.connect(identity);
    const state = new URL(result.authorizationUrl).searchParams.get('state')!;
    return { ...result, state };
  };
  const secrets = () =>
    JSON.parse(vault.decrypt(row.credentialsEncrypted, scope));
  const authorize = async () => {
    const r = await connect();
    await gmail.callback(r.state, 'code', r.binding);
  };
  return {
    gmail,
    db,
    google,
    row,
    vault,
    states,
    connect,
    authorize,
    secrets,
    config,
    scope,
  };
}
beforeEach(() => {
  vi.stubEnv('GATEWAY_ENCRYPTION_KEY', randomBytes(32).toString('hex'));
  vi.stubEnv(
    'COMMUNICATION_GMAIL_CALLBACK_URL',
    'https://api.example.test/communication/gmail/callback',
  );
});
afterEach(() => vi.unstubAllEnvs());
describe('GLOBAL Gmail OAuth lifecycle', () => {
  it('creates unpredictable hashed expiring state, official scopes and fixed redirect; never exposes tokens', async () => {
    const f = fixture(),
      first = await f.connect(),
      second = await f.connect();
    expect(first.state).not.toBe(second.state);
    expect(first.binding).not.toBe(second.binding);
    const saved = f.states.get(oauthHash(first.state))!;
    expect(saved).toMatchObject({
      actorId: 'admin',
      sessionId: 'session',
      bindingHash: oauthHash(first.binding),
      configurationRevision: 1,
    });
    expect(saved.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(600000);
    expect(JSON.stringify([...f.states.values()])).not.toContain(first.state);
    const url = new URL(first.authorizationUrl);
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('scope')).toBe(
      `${GMAIL_SCOPE} ${GOOGLE_EMAIL_SCOPE}`,
    );
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(first.authorizationUrl).not.toContain('CLIENT_SECRET');
  });
  it.each([
    'expired',
    'invalid',
    'binding',
    'session',
    'password',
    'replay',
    'config',
  ])('rejects %s before token exchange', async (condition) => {
    const f = fixture(),
      r = await f.connect();
    if (condition === 'expired')
      f.states.get(oauthHash(r.state))!.expiresAt = new Date(0);
    if (condition === 'invalid')
      r.state = randomBytes(32).toString('base64url');
    if (condition === 'binding')
      r.binding = randomBytes(32).toString('base64url');
    if (condition === 'session')
      f.db.authSession.findFirst.mockResolvedValue(null);
    if (condition === 'password')
      f.db.authSession.findFirst.mockResolvedValue({
        id: 'session',
        credentialHash: credentialHash('HASH'),
        user: { passwordHash: 'CHANGED' },
      });
    if (condition === 'replay')
      f.states.get(oauthHash(r.state))!.usedAt = new Date();
    if (condition === 'config') f.row.revision++;
    await expect(
      f.gmail.callback(r.state, 'code', r.binding),
    ).rejects.toThrow();
    expect(f.google.token).not.toHaveBeenCalled();
  });
  it('consumes state atomically during concurrent callbacks; encrypts credentials and returns safe status', async () => {
    const f = fixture(),
      r = await f.connect();
    const results = await Promise.allSettled([
      f.gmail.callback(r.state, 'code', r.binding),
      f.gmail.callback(r.state, 'code', r.binding),
    ]);
    expect(results.filter((v) => v.status === 'fulfilled')).toHaveLength(1);
    expect(f.google.token).toHaveBeenCalledTimes(1);
    expect(f.google.token).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'code',
        code_verifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        client_id: f.config.clientId,
        client_secret: 'CLIENT_SECRET',
        redirect_uri: gmailRedirectUri(),
        grant_type: 'authorization_code',
      }),
    );
    expect(f.row.credentialsEncrypted).not.toContain('REFRESH_TOKEN');
    expect(f.secrets().refreshToken).toBe('REFRESH_TOKEN');
    expect(await f.gmail.status()).toMatchObject({
      connected: true,
      accountEmail: 'sender@example.test',
    });
    expect(JSON.stringify(await f.gmail.status())).not.toMatch(
      /CLIENT_SECRET|ACCESS_TOKEN|REFRESH_TOKEN/,
    );
    const config = new CommunicationConfiguration(f.db as never, f.vault, {
      available: () => true,
    } as never);
    expect(JSON.stringify(await config.list())).not.toMatch(
      /CLIENT_SECRET|ACCESS_TOKEN|REFRESH_TOKEN|credentialsEncrypted/,
    );
    await expect(
      config.patch('GMAIL', { secrets: { refreshToken: 'INJECTED' } }, 'admin'),
    ).rejects.toThrow();
  });
  it.each([
    'denied',
    'missingRefresh',
    'missingScope',
    'wrongAccount',
    'exchangeError',
  ])(
    'rejects or closes %s safely without token persistence',
    async (condition) => {
      const f = fixture(),
        r = await f.connect();
      const before = f.row.credentialsEncrypted;
      if (condition === 'missingRefresh')
        f.google.token.mockResolvedValue({
          accessToken: 'ACCESS',
          expiresAt: '99999',
          scope: GMAIL_SCOPE,
        } as never);
      if (condition === 'missingScope')
        f.google.token.mockResolvedValue({
          accessToken: 'ACCESS',
          refreshToken: 'REFRESH',
          expiresAt: '99999',
          scope: '',
        });
      if (condition === 'wrongAccount')
        f.google.account.mockResolvedValue('other@example.test');
      if (condition === 'exchangeError')
        f.google.token.mockRejectedValue(new Error('code CLIENT_SECRET'));
      if (condition === 'denied')
        expect(
          await f.gmail.callback(r.state, undefined, r.binding, true),
        ).toEqual({ connected: false });
      else
        await expect(
          f.gmail.callback(r.state, 'code', r.binding),
        ).rejects.toThrow('GMAIL_CONNECT_FAILED');
      expect(f.row.credentialsEncrypted).toBe(before);
      expect(f.states.get(oauthHash(r.state))!.usedAt).toBeTruthy();
    },
  );
  it('uses unexpired access token and sends base64url RFC MIME with protected headers', async () => {
    const f = fixture();
    await f.authorize();
    f.google.token.mockClear();
    expect(
      await f.gmail.send(f.config, f.secrets(), {
        to: 'owner@example.test',
        subject: 'Olá',
        text: 'texto',
        html: '<p>texto</p>',
      }),
    ).toBe('message-id');
    expect(f.google.token).not.toHaveBeenCalled();
    const [token, raw] = f.google.send.mock.calls[0];
    expect(token).toBe('ACCESS_TOKEN');
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    const mime = Buffer.from(raw, 'base64url').toString();
    expect(mime).toContain('To: owner@example.test');
    expect(mime).toContain('multipart/alternative');
    await expect(
      f.gmail.send(f.config, f.secrets(), {
        to: 'owner@example.test',
        subject: 'x\r\nBcc: injected@example.test',
        text: 'x',
      }),
    ).rejects.toThrow();
    await expect(
      f.gmail.send(f.config, f.secrets(), {
        to: 'x\r\nBcc: bad',
        subject: 'x',
        text: 'x',
      }),
    ).rejects.toThrow();
  });
  it('refreshes once, retains refresh token omitted by Google and persists encrypted access token without changing delivery revision', async () => {
    const f = fixture();
    await f.authorize();
    f.row.credentialsEncrypted = f.vault.encrypt(
      JSON.stringify({ ...f.secrets(), expiresAt: '0' }),
      f.scope,
    );
    f.google.token.mockResolvedValue({
      accessToken: 'NEW_ACCESS',
      expiresAt: String(Date.now() + 3600000),
      scope: GMAIL_SCOPE,
    } as never);
    const revision = f.row.revision;
    f.google.token.mockClear();
    await f.gmail.verify(f.config, f.secrets());
    expect(f.google.token).toHaveBeenCalledTimes(1);
    expect(f.google.token).toHaveBeenCalledWith(
      expect.objectContaining({
        grant_type: 'refresh_token',
        refresh_token: 'REFRESH_TOKEN',
      }),
    );
    expect(f.secrets().refreshToken).toBe('REFRESH_TOKEN');
    expect(f.secrets().accessToken).toBe('NEW_ACCESS');
    expect(f.row.revision).toBe(revision);
  });
  it.each(['AUTH', 'TRANSIENT', 'RATE_LIMIT'] as const)(
    'handles refresh %s without loops or leaking errors',
    async (kind) => {
      const f = fixture();
      await f.authorize();
      f.row.credentialsEncrypted = f.vault.encrypt(
        JSON.stringify({ ...f.secrets(), expiresAt: '0' }),
        f.scope,
      );
      f.google.token.mockClear().mockRejectedValue(new TransportFailure(kind));
      await expect(f.gmail.verify(f.config, f.secrets())).rejects.toMatchObject(
        { kind },
      );
      expect(f.google.token).toHaveBeenCalledTimes(1);
      if (kind === 'AUTH') {
        expect(f.row.lastError).toBe('GMAIL_RECONNECT_REQUIRED');
        expect(f.secrets().refreshToken).toBeUndefined();
      } else expect(f.secrets().refreshToken).toBe('REFRESH_TOKEN');
    },
  );
  it('treats revoked API authorization as reconnect required', async () => {
    const f = fixture();
    await f.authorize();
    f.google.send.mockRejectedValue(new TransportFailure('AUTH'));
    await expect(
      f.gmail.send(f.config, f.secrets(), {
        to: 'owner@example.test',
        subject: 'x',
        text: 'x',
      }),
    ).rejects.toMatchObject({ kind: 'AUTH' });
    expect(f.row.enabled).toBe(false);
    expect((await f.gmail.status()).reconnectRequired).toBe(true);
  });
  it.each([true, false])(
    'disconnects locally before revocation even with remote success=%s',
    async (success) => {
      const f = fixture();
      await f.authorize();
      if (!success)
        f.google.revoke.mockRejectedValue(new TransportFailure('TRANSIENT'));
      f.google.revoke.mockImplementation(async () => {
        expect(f.secrets().refreshToken).toBeUndefined();
        if (!success) throw new TransportFailure('TRANSIENT');
      });
      expect(await f.gmail.disconnect('admin')).toEqual({
        disconnected: true,
        remoteRevoked: success,
      });
      expect(f.row.enabled).toBe(false);
      expect(f.secrets()).toEqual({ clientSecret: 'CLIENT_SECRET' });
      expect(
        JSON.stringify(f.db.globalCommunicationLog.create.mock.calls),
      ).not.toMatch(/CLIENT_SECRET|REFRESH_TOKEN|ACCESS_TOKEN/);
    },
  );
  it('fails closed without configuration and invalid callback URL', async () => {
    const f = fixture();
    f.db.globalCommunicationProvider.findUnique.mockResolvedValue(
      null as never,
    );
    await expect(f.connect()).rejects.toThrow();
    expect((await f.gmail.status()).configured).toBe(false);
    vi.stubEnv(
      'COMMUNICATION_GMAIL_CALLBACK_URL',
      'https://evil.test?redirect=x',
    );
    expect(gmailRedirectUri).toThrow();
  });
});
