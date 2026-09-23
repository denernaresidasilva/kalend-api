import { randomBytes, randomUUID } from 'node:crypto';
import { AuthConfig } from './auth.config.js';
import { AuthRateLimit } from './auth-rate-limit.service.js';
import { TenantGuard } from './tenant.guard.js';
import { readCookie } from './auth.http.js';
import { AuthService } from './auth.service.js';
import { AuthTokens } from './auth.tokens.js';
import { authDatabase, MEMBER_ID } from '../../test/support/auth-database.js';
describe('authorization and limiting boundaries', () => {
  beforeEach(() =>
    vi.stubEnv('AUTH_JWT_SECRET', randomBytes(32).toString('hex')),
  );
  afterEach(() => vi.unstubAllEnvs());
  it('enforces a shared atomic bucket and hashes identifiers', async () => {
    const store = authDatabase('unused');
    const limiter = new AuthRateLimit(store.db as never, new AuthConfig());
    await limiter.consume('login-email', 'person@example.test', 2, 900);
    await limiter.consume('login-email', 'person@example.test', 2, 900);
    await expect(
      limiter.consume('login-email', 'person@example.test', 2, 900),
    ).rejects.toThrow('Muitas tentativas');
    const call = store.db.authRateLimit.upsert.mock.calls[0][0];
    expect(call.where.key).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(call)).not.toContain('person@example.test');
  });
  it('rejects duplicate auth cookie names', () => {
    expect(() =>
      readCookie({ headers: { cookie: 'a=x; a=y' } } as never, 'a'),
    ).toThrow();
  });
  it('rejects wildcard origins and broad trusted proxies', () => {
    const config = new AuthConfig();
    vi.stubEnv('AUTH_ALLOWED_ORIGINS', '*');
    expect(() => config.origins()).toThrow();
    vi.stubEnv('AUTH_TRUSTED_PROXY_CIDRS', '0.0.0.0/0');
    expect(() => config.trustedProxies()).toThrow();
  });
  it('enforces tenant role in addition to membership', async () => {
    const req = {
      method: 'GET',
      headers: { cookie: '__Host-kalend_access=x' },
    };
    const auth = {
      authenticate: vi.fn().mockResolvedValue({
        user: { id: MEMBER_ID },
        session: { selectedCompanyId: randomUUID() },
      }),
      membership: vi.fn().mockResolvedValue({ id: 'm', role: 'CLIENT' }),
    };
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => ({ setHeader: vi.fn(), vary: vi.fn() }),
      }),
      getHandler: () => {},
      getClass: () => {},
    };
    const guard = new TenantGuard(auth as never, new AuthConfig(), {
      getAllAndOverride: () => ['OWNER'],
    } as never);
    await expect(guard.canActivate(ctx as never)).rejects.toThrow(
      'Papel sem permissão',
    );
    auth.membership.mockResolvedValue({ id: 'm', role: 'OWNER' });
    expect(await guard.canActivate(ctx as never)).toBe(true);
  });
  it('rejects a valid JWT bound to a session belonging to another user', async () => {
    const store = authDatabase('unused');
    const { credentialHash } = await import('./auth.tokens.js');
    const id = randomUUID();
    store.sessions.push({
      id,
      userId: MEMBER_ID,
      credentialHash: credentialHash('unused'),
      selectedCompanyId: null,
      createdAt: new Date(),
      lastUsedAt: new Date(),
      expiresAt: new Date(Date.now() + 86400000),
      refreshExpiresAt: new Date(Date.now() + 86400000),
      revokedAt: null,
    });
    const tokens = new AuthTokens(new AuthConfig());
    const service = new AuthService(
      store.db as never,
      tokens,
      new AuthRateLimit(store.db as never, new AuthConfig()),
    );
    const raw = await tokens.access(
      randomUUID(),
      id,
      new Date(Date.now() + 600000),
    );
    await expect(service.authenticate(raw)).rejects.toThrow('Sessão inválida');
  });
  it('losing refresh claim commits family revocation instead of rolling it back', async () => {
    const store = authDatabase('unused');
    const now = new Date();
    const raw = 'A'.repeat(43);
    const { refreshHash, credentialHash } = await import('./auth.tokens.js');
    const id = randomUUID();
    store.sessions.push({
      id,
      userId: MEMBER_ID,
      credentialHash: credentialHash('unused'),
      selectedCompanyId: null,
      createdAt: now,
      lastUsedAt: now,
      expiresAt: new Date(Date.now() + 86400000),
      refreshExpiresAt: new Date(Date.now() + 86400000),
      revokedAt: null,
    });
    store.refreshes.push({
      id: randomUUID(),
      sessionId: id,
      tokenHash: refreshHash(raw),
      usedAt: null,
      expiresAt: new Date(Date.now() + 86400000),
    });
    store.db.authRefreshToken.updateMany.mockResolvedValueOnce({ count: 0 });
    const service = new AuthService(
      store.db as never,
      new AuthTokens(new AuthConfig()),
      new AuthRateLimit(store.db as never, new AuthConfig()),
    );
    await expect(service.refresh(raw, 'ip')).rejects.toThrow('Sessão inválida');
    expect(store.sessions[0].revokedAt).toBeInstanceOf(Date);
    expect(store.refreshes).toHaveLength(1);
  });
});
