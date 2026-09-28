import {
  BadRequestException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { GatewayContext, Headers } from '../gateway.types.js';
// Provider responses are untrusted; adapters select and validate identifiers/money before persistence.
export type Remote = Record<string, any>;
const hosts = new Set([
  'api.stripe.com',
  'api.mercadopago.com',
  'api.asaas.com',
  'api-sandbox.asaas.com',
  'api.pagseguro.com',
  'sandbox.api.pagseguro.com',
  'api.assinaturas.pagseguro.com',
  'sandbox.api.assinaturas.pagseguro.com',
]);
export async function request(
  url: string,
  headers: Record<string, string>,
  method = 'GET',
  body?: Remote | URLSearchParams,
): Promise<Remote> {
  try {
    const target = new URL(url);
    if (
      target.protocol !== 'https:' ||
      !hosts.has(target.hostname) ||
      target.username ||
      target.password ||
      target.port
    )
      throw new Error();
    const response = await fetch(target, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Kalend-Billing/1.0',
        ...headers,
        ...(body
          ? {
              'Content-Type':
                body instanceof URLSearchParams
                  ? 'application/x-www-form-urlencoded'
                  : 'application/json',
            }
          : {}),
      },
      ...(body && method !== 'GET' && method !== 'HEAD'
        ? {
            body:
              body instanceof URLSearchParams
                ? body.toString()
                : JSON.stringify(body),
          }
        : {}),
    });
    if (!response.ok) throw new Error();
    if (response.status === 204) return {};
    const text = await response.text();
    if (text.length > 1048576) throw new Error();
    const data: unknown = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data))
      throw new Error();
    return data as Remote;
  } catch {
    throw new ServiceUnavailableException('GATEWAY_REQUEST_FAILED');
  }
}
export function id(value: unknown): string {
  if (
    (typeof value !== 'string' && typeof value !== 'number') ||
    !/^[a-zA-Z0-9_&-]{1,200}$/.test(String(value))
  )
    throw new BadRequestException('GATEWAY_INVALID_ID');
  return String(value);
}
export function cents(value: unknown, decimal = false): number {
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    !/^\d+(\.\d{1,2})?$/.test(String(value))
  )
    throw new BadRequestException('GATEWAY_INVALID_AMOUNT');
  const n = decimal ? Math.round(Number(value) * 100) : Number(value);
  if (!Number.isSafeInteger(n) || n < 0 || n > 2147483647)
    throw new BadRequestException('GATEWAY_INVALID_AMOUNT');
  return n;
}
export function header(headers: Headers, name: string): string {
  const value = headers[name];
  if (typeof value !== 'string')
    throw new UnauthorizedException('WEBHOOK_INVALID_SIGNATURE');
  return value;
}
export function equalSecret(actual: string, expected: string) {
  const a = createHash('sha256').update(actual).digest();
  const b = createHash('sha256').update(expected).digest();
  if (!expected || !timingSafeEqual(a, b))
    throw new UnauthorizedException('WEBHOOK_INVALID_SIGNATURE');
}
export function json(raw: Buffer): Remote {
  try {
    const data = JSON.parse(raw.toString('utf8')) as unknown;
    if (!data || typeof data !== 'object' || Array.isArray(data))
      throw new Error();
    return data as Remote;
  } catch {
    throw new BadRequestException('WEBHOOK_INVALID_BODY');
  }
}
export function live(value: unknown, c: GatewayContext) {
  if (typeof value !== 'boolean' || value !== (c.environment === 'PRODUCTION'))
    throw new BadRequestException('GATEWAY_ENVIRONMENT_MISMATCH');
}
export function fresh(ts: string) {
  if (
    !/^\d{10,13}$/.test(ts) ||
    Math.abs(Date.now() - Number(ts) * (ts.length === 13 ? 1 : 1000)) > 300000
  )
    throw new UnauthorizedException('WEBHOOK_EXPIRED_SIGNATURE');
}
export function callback(path: string): string {
  const base = process.env.BILLING_PUBLIC_API_URL;
  if (!base)
    throw new ServiceUnavailableException('BILLING_PUBLIC_API_URL_REQUIRED');
  return configuredUrl(base, path);
}
export function returnUrl(): string {
  if (!process.env.BILLING_RETURN_URL)
    throw new ServiceUnavailableException('BILLING_RETURN_URL_REQUIRED');
  return configuredUrl(process.env.BILLING_RETURN_URL);
}
function configuredUrl(value: string, path?: string) {
  try {
    const u = new URL(path ?? value, value);
    if (u.protocol !== 'https:' || u.username || u.password || u.hash)
      throw new Error();
    return u.toString();
  } catch {
    throw new ServiceUnavailableException('BILLING_URL_INVALID');
  }
}
export function checkoutUrl(
  value: unknown,
  domains: string[],
): string | undefined {
  if (value == null) return undefined;
  try {
    if (typeof value !== 'string') throw new Error();
    const u = new URL(value);
    if (
      u.protocol !== 'https:' ||
      u.username ||
      u.password ||
      !domains.some((d) => u.hostname === d || u.hostname.endsWith('.' + d))
    )
      throw new Error();
    return u.toString();
  } catch {
    throw new BadRequestException('GATEWAY_CHECKOUT_URL_INVALID');
  }
}
export function eventId(resource: string, status: string, refund = 0) {
  return `reconcile:${resource}:${status}:${refund}`;
}
