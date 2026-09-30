import { Injectable } from '@nestjs/common';
import { secureRequest, responseObject } from './secure-http.js';
import { TransportFailure, email } from './contracts.js';
import type { Variables } from './contracts.js';
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
export const GOOGLE_EMAIL_SCOPE = 'openid email';

@Injectable()
export class GoogleApi {
  async token(parameters: Variables) {
    const result = await secureRequest(
      new URL('https://oauth2.googleapis.com/token'),
      'POST',
      { 'Content-Type': 'application/x-www-form-urlencoded' },
      Buffer.from(new URLSearchParams(parameters).toString()),
    );
    if (result.status === 429) throw new TransportFailure('RATE_LIMIT');
    if (result.status >= 500) throw new TransportFailure('TRANSIENT');
    if (result.status !== 200) throw new TransportFailure('AUTH');
    const data = responseObject(result);
    if (
      typeof data.access_token !== 'string' ||
      !data.access_token ||
      Array.from(data.access_token).some(
        (char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127,
      ) ||
      data.access_token.length > 16384 ||
      !Number.isInteger(data.expires_in) ||
      Number(data.expires_in) < 1 ||
      Number(data.expires_in) > 86400 ||
      data.token_type !== 'Bearer' ||
      (data.refresh_token !== undefined &&
        (typeof data.refresh_token !== 'string' ||
          !data.refresh_token ||
          data.refresh_token.length > 16384))
    )
      throw new TransportFailure('AUTH');
    return {
      accessToken: data.access_token,
      expiresAt: String(Date.now() + Number(data.expires_in) * 1000),
      ...(typeof data.refresh_token === 'string'
        ? { refreshToken: data.refresh_token }
        : {}),
      scope: typeof data.scope === 'string' ? data.scope : '',
    };
  }
  async account(token: string) {
    const result = await secureRequest(
      new URL('https://openidconnect.googleapis.com/v1/userinfo'),
      'GET',
      { Authorization: `Bearer ${token}` },
    );
    this.check(result.status, false);
    const data = responseObject(result);
    if (data.email_verified !== true) throw new TransportFailure('AUTH');
    return email(data.email);
  }
  async send(token: string, raw: string) {
    const result = await secureRequest(
      new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages/send'),
      'POST',
      { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      Buffer.from(JSON.stringify({ raw })),
    );
    this.check(result.status, true, result.body);
    const id = responseObject(result).id;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(id))
      throw new TransportFailure('UNCERTAIN');
    return id;
  }
  private check(status: number, sending: boolean, body?: Buffer) {
    if (status === 403 && body) {
      try {
        const value = JSON.parse(body.toString('utf8')) as {
          error?: { errors?: { reason?: string }[] };
        };
        const reasons = value.error?.errors?.map((error) => error.reason) ?? [];
        if (
          reasons.some(
            (reason) =>
              reason === 'rateLimitExceeded' ||
              reason === 'userRateLimitExceeded',
          )
        )
          throw new TransportFailure('RATE_LIMIT');
        if (reasons.includes('dailyLimitExceeded'))
          throw new TransportFailure('PERMANENT');
      } catch (error) {
        if (error instanceof TransportFailure) throw error;
      }
    }
    if (status >= 200 && status < 300) return;
    throw new TransportFailure(
      status === 429
        ? 'RATE_LIMIT'
        : status === 401 || status === 403
          ? 'AUTH'
          : status >= 500
            ? sending
              ? 'UNCERTAIN'
              : 'TRANSIENT'
            : 'PERMANENT',
    );
  }
  async revoke(token: string) {
    const result = await secureRequest(
      new URL('https://oauth2.googleapis.com/revoke'),
      'POST',
      { 'Content-Type': 'application/x-www-form-urlencoded' },
      Buffer.from(new URLSearchParams({ token }).toString()),
    );
    // Already invalid tokens are disconnected too; transport failure is reported separately.
    if (result.status !== 200 && result.status !== 400)
      this.check(result.status, false);
  }
}
