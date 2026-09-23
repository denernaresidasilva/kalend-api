import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { isIP } from 'node:net';
export const ACCESS_SECONDS = 600;
export const REFRESH_SECONDS = 7 * 86400;
export const SESSION_SECONDS = 30 * 86400;
export const ACCESS_COOKIE = '__Host-kalend_access';
export const REFRESH_COOKIE = '__Host-kalend_refresh';
@Injectable()
export class AuthConfig {
  key(): Uint8Array {
    const value = process.env.AUTH_JWT_SECRET;
    if (!value || !/^[a-f0-9]{64}$/i.test(value))
      throw new ServiceUnavailableException('AUTH_NOT_CONFIGURED');
    return Buffer.from(value, 'hex');
  }
  origins(): string[] {
    const values = (process.env.AUTH_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    if (
      values.some((value) => {
        try {
          const url = new URL(value);
          return url.protocol !== 'https:' || url.origin !== value;
        } catch {
          return true;
        }
      })
    )
      throw new ServiceUnavailableException('AUTH_ORIGINS_INVALID');
    return values;
  }
  trustedProxies(): string[] {
    const values = (process.env.AUTH_TRUSTED_PROXY_CIDRS ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    for (const value of values) {
      const [ip, prefix, extra] = value.split('/');
      const version = isIP(ip);
      if (
        !version ||
        extra ||
        (prefix !== undefined &&
          (!/^\d+$/.test(prefix) ||
            Number(prefix) < (version === 4 ? 8 : 32) ||
            Number(prefix) > (version === 4 ? 32 : 128)))
      )
        throw new ServiceUnavailableException('AUTH_PROXY_CONFIG_INVALID');
    }
    return values;
  }
}
