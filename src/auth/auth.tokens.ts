import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { ACCESS_SECONDS, AuthConfig } from './auth.config.js';
export function refreshHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
export function newRefresh(): string {
  return randomBytes(32).toString('base64url');
}
export function validRefresh(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}
@Injectable()
export class AuthTokens {
  constructor(@Inject(AuthConfig) private readonly config: AuthConfig) {}
  async access(userId: string, sessionId: string, expiresAt: Date) {
    return new SignJWT({ sid: sessionId })
      .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' })
      .setSubject(userId)
      .setIssuer('kalend-api')
      .setAudience('kalend-web')
      .setIssuedAt()
      .setJti(randomUUID())
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .sign(this.config.key());
  }
  async verify(raw: string) {
    const key = this.config.key();
    try {
      if (raw.length > 4096) throw new Error();
      const { payload } = await jwtVerify(raw, key, {
        algorithms: ['HS256'],
        typ: 'at+jwt',
        issuer: 'kalend-api',
        audience: 'kalend-web',
        requiredClaims: ['sub', 'sid', 'iat', 'exp', 'jti'],
        maxTokenAge: ACCESS_SECONDS,
        clockTolerance: 0,
      });
      const uuid =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (
        typeof payload.sub !== 'string' ||
        typeof payload.sid !== 'string' ||
        !uuid.test(payload.sub) ||
        !uuid.test(payload.sid) ||
        typeof payload.iat !== 'number' ||
        typeof payload.exp !== 'number' ||
        payload.exp - payload.iat > ACCESS_SECONDS
      )
        throw new Error();
      return { userId: payload.sub, sessionId: payload.sid };
    } catch {
      throw new UnauthorizedException('Sessão inválida ou expirada.');
    }
  }
}

/** Non-reversible snapshot of the existing bcrypt hash; invalidates sessions after any password change. */
export function credentialHash(passwordHash: string): string {
  return createHash('sha256')
    .update(`kalend-credential:${passwordHash}`)
    .digest('hex');
}
