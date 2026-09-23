import { BadRequestException } from '@nestjs/common';
export function object(
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BadRequestException('Objeto JSON obrigatório.');
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !allowed.includes(key)))
    throw new BadRequestException('Campo não permitido.');
  return result;
}
export function string(value: unknown, field: string, max = 255): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new BadRequestException(`Campo inválido: ${field}.`);
  return value.trim();
}
export function uuid(value: unknown): string {
  const result = string(value, 'id', 36);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      result,
    )
  )
    throw new BadRequestException('UUID inválido.');
  return result;
}
export function boolean(value: unknown, field: string) {
  if (value !== undefined && typeof value !== 'boolean')
    throw new BadRequestException(`Campo inválido: ${field}.`);
}
export function integer(
  value: unknown,
  field: string,
  min = 0,
  max = 2147483647,
) {
  if (
    !Number.isInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  )
    throw new BadRequestException(`Campo inválido: ${field}.`);
}
export const safeUserSelect = {
  id: true,
  name: true,
  email: true,
  phone: true,
  isActive: true,
  isSuperAdmin: true,
  createdAt: true,
  updatedAt: true,
} as const;
export const safeEventSelect = {
  id: true,
  gateway: true,
  externalEventId: true,
  eventType: true,
  status: true,
  receivedAt: true,
  processedAt: true,
  createdAt: true,
  updatedAt: true,
  companyId: true,
  paymentId: true,
  attempts: true,
  environment: true,
} as const;
