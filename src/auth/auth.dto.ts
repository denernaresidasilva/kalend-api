import { BadRequestException } from '@nestjs/common';
import { object, string, uuid } from '../common/validation.js';
export interface LoginDto {
  email: string;
  password: string;
}
export interface SelectTenantDto {
  companyId: string | null;
}
/** Explicit runtime parsers: TypeScript interfaces alone do not validate HTTP input. */
export function parseLoginDto(input: unknown): LoginDto {
  const data = object(input, ['email', 'password']);
  const email = string(data.email, 'email', 254).toLowerCase();
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    typeof data.password !== 'string' ||
    !data.password.length ||
    Buffer.byteLength(data.password) > 72
  )
    throw new BadRequestException('Credenciais inválidas.');
  return { email, password: data.password }; // Never trim/normalize a password.
}
export function parseSelectTenantDto(input: unknown): SelectTenantDto {
  const data = object(input, ['companyId']);
  return { companyId: data.companyId === null ? null : uuid(data.companyId) };
}
