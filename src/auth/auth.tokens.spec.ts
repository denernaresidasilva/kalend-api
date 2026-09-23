import { randomBytes, randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { AuthTokens, newRefresh, refreshHash } from './auth.tokens.js';
import { AuthConfig } from './auth.config.js';
const userId = randomUUID(),
  sessionId = randomUUID();
describe('JWT validation', () => {
  let key: Buffer;
  let tokens: AuthTokens;
  beforeEach(() => {
    key = randomBytes(32);
    vi.stubEnv('AUTH_JWT_SECRET', key.toString('hex'));
    tokens = new AuthTokens(new AuthConfig());
  });
  afterEach(() => vi.unstubAllEnvs());
  function jwt(algorithm = 'HS256') {
    return new SignJWT({ sid: sessionId })
      .setProtectedHeader({ alg: algorithm, typ: 'at+jwt' })
      .setSubject(userId)
      .setIssuer('kalend-api')
      .setAudience('kalend-web')
      .setIssuedAt()
      .setJti(randomUUID());
  }
  it('verifies real signature and expiry', async () => {
    const raw = await tokens.access(
      userId,
      sessionId,
      new Date(Date.now() + 600000),
    );
    expect(await tokens.verify(raw)).toEqual({ userId, sessionId });
  });
  it('rejects expired access', async () => {
    await expect(
      tokens.verify(await jwt().setExpirationTime('0s').sign(key)),
    ).rejects.toThrow();
  });
  it('rejects missing expiration', async () => {
    await expect(tokens.verify(await jwt().sign(key))).rejects.toThrow();
  });
  it('rejects extended lifetime', async () => {
    await expect(
      tokens.verify(await jwt().setExpirationTime('2h').sign(key)),
    ).rejects.toThrow();
  });
  it('rejects another audience', async () => {
    await expect(
      tokens.verify(
        await jwt().setAudience('other').setExpirationTime('5m').sign(key),
      ),
    ).rejects.toThrow();
  });
  it('rejects a different algorithm', async () => {
    await expect(
      tokens.verify(await jwt('HS384').setExpirationTime('5m').sign(key)),
    ).rejects.toThrow();
  });
  it('rejects forgery and unsigned JWT', async () => {
    await expect(
      tokens.verify(await jwt().setExpirationTime('5m').sign(randomBytes(32))),
    ).rejects.toThrow();
    await expect(
      tokens.verify(
        `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{}').toString('base64url')}.`,
      ),
    ).rejects.toThrow();
  });
  it('uses random opaque refresh tokens and stores a digest', () => {
    const a = newRefresh(),
      b = newRefresh();
    expect(a).toHaveLength(43);
    expect(a).not.toBe(b);
    expect(refreshHash(a)).toHaveLength(64);
    expect(refreshHash(a)).not.toBe(a);
  });
  it('has no fallback signing secret', async () => {
    vi.stubEnv('AUTH_JWT_SECRET', '');
    await expect(tokens.access(userId, sessionId, new Date())).rejects.toThrow(
      'AUTH_NOT_CONFIGURED',
    );
  });
});
