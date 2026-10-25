import { randomBytes, randomUUID } from 'node:crypto';
import * as bcrypt from 'bcrypt';
import { AuthConfig } from './auth.config.js';
import { AuthRateLimit } from './auth-rate-limit.service.js';
import { TenantGuard } from './tenant.guard.js';
import { AuthGuard } from './auth.guard.js';
import { ForbiddenException } from '@nestjs/common';
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
  it('builds only a root login URL from an explicitly allowed HTTPS origin', () => {
    const config = new AuthConfig();
    vi.stubEnv('AUTH_ALLOWED_ORIGINS', 'https://dev.kalend.tech');
    expect(config.loginUrl('https://dev.kalend.tech')).toBe('https://dev.kalend.tech/');
    expect(() => config.loginUrl('https://attacker.example')).toThrow();
    expect(() => config.loginUrl('https://dev.kalend.tech.evil.example')).toThrow();
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
    auth.membership.mockRejectedValue(new Error('Acesso à empresa não permitido.'));
    await expect(guard.canActivate(ctx as never)).rejects.toThrow(
      'Acesso à empresa não permitido',
    );
  });
  it('clears persisted browser cookies when an old access token belongs to an orphan', async () => {
    const response = { setHeader: vi.fn(), vary: vi.fn(), clearCookie: vi.fn() };
    const request = { method: 'GET', headers: { cookie: '__Host-kalend_access=stale' } };
    const auth = {
      authenticate: vi.fn().mockRejectedValue(new ForbiddenException({
        code: 'NO_ACTIVE_COMPANY',
        message: 'Esta conta não possui uma empresa vinculada.',
      })),
    };
    const guard = new AuthGuard(auth as never, new AuthConfig());
    const context = {
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    };
    await expect(guard.canActivate(context as never)).rejects.toMatchObject({
      response: { code: 'NO_ACTIVE_COMPANY' },
    });
    expect(response.clearCookie).toHaveBeenCalledTimes(2);
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
  it('rejects old access and refresh credentials after a company deletion revokes the user session', async () => {
    const store = authDatabase('unused');
    const { credentialHash, newRefresh, refreshHash } = await import('./auth.tokens.js');
    const now = new Date();
    const sessionId = randomUUID();
    const refresh = newRefresh();
    store.sessions.push({
      id: sessionId,
      userId: MEMBER_ID,
      credentialHash: credentialHash('unused'),
      selectedCompanyId: randomUUID(),
      createdAt: now,
      lastUsedAt: now,
      expiresAt: new Date(now.getTime() + 86400000),
      refreshExpiresAt: new Date(now.getTime() + 86400000),
      revokedAt: null,
    });
    store.refreshes.push({
      id: randomUUID(),
      sessionId,
      tokenHash: refreshHash(refresh),
      expiresAt: new Date(now.getTime() + 86400000),
      usedAt: null,
    });
    const tokens = new AuthTokens(new AuthConfig());
    const service = new AuthService(
      store.db as never,
      tokens,
      new AuthRateLimit(store.db as never, new AuthConfig()),
    );
    const access = await tokens.access(
      MEMBER_ID,
      sessionId,
      new Date(now.getTime() + 600000),
    );

    store.users.find((user) => user.id === MEMBER_ID)!.isActive = false;
    store.sessions[0].revokedAt = now;

    await expect(service.authenticate(access)).rejects.toThrow('Sessão inválida');
    await expect(service.refresh(refresh, 'test-ip')).rejects.toThrow('Sessão inválida');
  });
  it('rejects a new login after the last-company deletion deactivates the owner account', async () => {
    const store = authDatabase('unused');
    const password = 'test-only-owner-password';
    const owner = store.users.find((user) => user.id === MEMBER_ID)!;
    owner.passwordHash = await bcrypt.hash(password, 4);
    owner.isActive = false;
    const service = new AuthService(
      store.db as never,
      new AuthTokens(new AuthConfig()),
      new AuthRateLimit(store.db as never, new AuthConfig()),
    );

    await expect(
      service.login({ email: owner.email, password }, 'test-ip'),
    ).rejects.toThrow('E-mail ou senha inválidos');
    expect(store.sessions).toHaveLength(0);
  });
  it('denies login for an active owner with no active company and creates no session or tokens', async () => {
    const password = await bcrypt.hash('owner-password', 4);
    const store = authDatabase(password);
    store.memberships.forEach((membership) => { membership.isActive = false; });
    const service = new AuthService(
      store.db as never,
      new AuthTokens(new AuthConfig()),
      new AuthRateLimit(store.db as never, new AuthConfig()),
    );

    await expect(
      service.login({ email: 'member@example.test', password: 'owner-password' }, 'test-ip'),
    ).rejects.toMatchObject({
      response: {
        code: 'NO_ACTIVE_COMPANY',
        message: 'Esta conta não possui uma empresa vinculada.',
      },
    });
    expect(store.sessions).toHaveLength(0);
    expect(store.refreshes).toHaveLength(0);
  });
  it('allows login for an active owner with an eligible active membership', async () => {
    const password = await bcrypt.hash('owner-password', 4);
    const store = authDatabase(password);
    const service = new AuthService(
      store.db as never, new AuthTokens(new AuthConfig()),
      new AuthRateLimit(store.db as never, new AuthConfig()),
    );
    await expect(service.login({ email: 'member@example.test', password: 'owner-password' }, 'test-ip'))
      .resolves.toMatchObject({ access: expect.any(String), refresh: expect.any(String) });
    expect(store.sessions).toHaveLength(1);
    expect(store.refreshes).toHaveLength(1);
  });
  it('denies login for an inactive orphan account without issuing a session', async () => {
    const password = await bcrypt.hash('owner-password', 4);
    const store = authDatabase(password);
    store.users.find((user) => user.id === MEMBER_ID)!.isActive = false;
    store.memberships.forEach((membership) => { membership.isActive = false; });
    const service = new AuthService(
      store.db as never, new AuthTokens(new AuthConfig()),
      new AuthRateLimit(store.db as never, new AuthConfig()),
    );
    await expect(service.login({ email: 'member@example.test', password: 'owner-password' }, 'test-ip'))
      .rejects.toMatchObject({ response: { code: 'NO_ACTIVE_COMPANY' } });
    expect(store.sessions).toHaveLength(0);
    expect(store.refreshes).toHaveLength(0);
  });
  it('allows a Super Admin to log in without a company membership', async () => {
    const password = await bcrypt.hash('admin-password', 4);
    const store = authDatabase(password);
    store.memberships.splice(0);
    store.users.find((user) => user.id === '11111111-1111-4111-8111-111111111111')!.passwordHash = password;
    const service = new AuthService(
      store.db as never,
      new AuthTokens(new AuthConfig()),
      new AuthRateLimit(store.db as never, new AuthConfig()),
    );
    await expect(service.login({ email: 'admin@example.test', password: 'admin-password' }, 'test-ip'))
      .resolves.toMatchObject({ access: expect.any(String), refresh: expect.any(String) });
    expect(store.sessions).toHaveLength(1);
  });
  it('revokes old sessions and denies access and refresh for an active orphan', async () => {
    const store = authDatabase('unused');
    const { credentialHash, newRefresh, refreshHash } = await import('./auth.tokens.js');
    const now = new Date();
    const sessionId = randomUUID();
    const refresh = newRefresh();
    store.sessions.push({
      id: sessionId,
      userId: MEMBER_ID,
      credentialHash: credentialHash('unused'),
      selectedCompanyId: randomUUID(),
      createdAt: now,
      lastUsedAt: now,
      expiresAt: new Date(now.getTime() + 86400000),
      refreshExpiresAt: new Date(now.getTime() + 86400000),
      revokedAt: null,
    });
    store.refreshes.push({
      id: randomUUID(), sessionId, tokenHash: refreshHash(refresh),
      expiresAt: new Date(now.getTime() + 86400000), usedAt: null,
    });
    store.memberships.forEach((membership) => { membership.isActive = false; });
    const tokens = new AuthTokens(new AuthConfig());
    const service = new AuthService(
      store.db as never,
      tokens,
      new AuthRateLimit(store.db as never, new AuthConfig()),
    );
    const access = await tokens.access(MEMBER_ID, sessionId, new Date(now.getTime() + 600000));
    await expect(service.authenticate(access)).rejects.toMatchObject({
      response: { code: 'NO_ACTIVE_COMPANY' },
    });
    expect(store.sessions[0].revokedAt).toBeInstanceOf(Date);
    await expect(service.refresh(refresh, 'test-ip')).rejects.toMatchObject({
      response: { code: 'NO_ACTIVE_COMPANY' },
    });
    expect(store.sessions[0].revokedAt).toBeInstanceOf(Date);
    expect(store.refreshes).toHaveLength(1);
  });
  it('revokes refresh sessions for an active orphan before rotating credentials', async () => {
    const store = authDatabase('unused');
    const { credentialHash, newRefresh, refreshHash } = await import('./auth.tokens.js');
    const now = new Date();
    const sessionId = randomUUID();
    const refresh = newRefresh();
    store.sessions.push({
      id: sessionId, userId: MEMBER_ID, credentialHash: credentialHash('unused'),
      selectedCompanyId: null, createdAt: now, lastUsedAt: now,
      expiresAt: new Date(now.getTime() + 86400000),
      refreshExpiresAt: new Date(now.getTime() + 86400000), revokedAt: null,
    });
    store.refreshes.push({ id: randomUUID(), sessionId, tokenHash: refreshHash(refresh), expiresAt: new Date(now.getTime() + 86400000), usedAt: null });
    store.memberships.forEach((membership) => { membership.isActive = false; });
    const service = new AuthService(
      store.db as never, new AuthTokens(new AuthConfig()),
      new AuthRateLimit(store.db as never, new AuthConfig()),
    );
    await expect(service.refresh(refresh, 'test-ip')).rejects.toMatchObject({
      response: { code: 'NO_ACTIVE_COMPANY' },
    });
    expect(store.sessions[0].revokedAt).toBeInstanceOf(Date);
    expect(store.refreshes).toHaveLength(1);
  });
  it('rejects an orphan profile from /auth/me and revokes persisted sessions', async () => {
    const store = authDatabase('unused');
    const now = new Date();
    const sessionId = randomUUID();
    store.sessions.push({
      id: sessionId, userId: MEMBER_ID, credentialHash: 'unused',
      selectedCompanyId: null, createdAt: now, lastUsedAt: now,
      expiresAt: new Date(now.getTime() + 86400000),
      refreshExpiresAt: new Date(now.getTime() + 86400000), revokedAt: null,
    });
    store.memberships.forEach((membership) => { membership.isActive = false; });
    const service = new AuthService(
      store.db as never, new AuthTokens(new AuthConfig()),
      new AuthRateLimit(store.db as never, new AuthConfig()),
    );
    await expect(service.me({
      user: { id: MEMBER_ID, name: 'Member', email: 'member@example.test', isActive: true, isSuperAdmin: false },
      session: { id: sessionId, selectedCompanyId: null, expiresAt: new Date(now.getTime() + 86400000), refreshExpiresAt: new Date(now.getTime() + 86400000) },
    })).rejects.toMatchObject({ response: { code: 'NO_ACTIVE_COMPANY' } });
    expect(store.sessions[0].revokedAt).toBeInstanceOf(Date);
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
