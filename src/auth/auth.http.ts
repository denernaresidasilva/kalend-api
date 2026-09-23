import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ACCESS_COOKIE, REFRESH_COOKIE } from './auth.config.js';
import type { AuthConfig } from './auth.config.js';
export function readCookie(request: Request, name: string): string | undefined {
  const parts = (request.headers.cookie ?? '')
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p.startsWith(`${name}=`));
  if (parts.length > 1) throw new UnauthorizedException('Sessão inválida.');
  return parts[0]?.slice(name.length + 1);
}
export function requireOrigin(request: Request, config: AuthConfig) {
  const origin = request.headers.origin;
  if (!origin || !config.origins().includes(origin))
    throw new ForbiddenException('Origem não autorizada.');
}
export function noStore(response: Response) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Pragma', 'no-cache');
  response.vary('Cookie');
}
export function clearAuthCookies(response: Response) {
  response.clearCookie(ACCESS_COOKIE, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/',
  });
  response.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/',
  });
}
export function setAuthCookies(
  response: Response,
  tokens: {
    access: string;
    refresh: string;
    accessExpiresAt: Date;
    refreshExpiresAt: Date;
  },
) {
  response.cookie(ACCESS_COOKIE, tokens.access, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/',
    expires: tokens.accessExpiresAt,
  });
  response.cookie(REFRESH_COOKIE, tokens.refresh, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/',
    expires: tokens.refreshExpiresAt,
  });
}
