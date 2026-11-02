import { BadRequestException, ConflictException } from '@nestjs/common';
export const terminalSale = (status: string) => ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED', 'CANCELLED'].includes(status);
export function totalSale(lines: Array<{ quantity: number; unitPriceCents: number; voidedAt: Date | null }>, discountCents = 0) {
  const subtotalCents = lines.filter(l => !l.voidedAt).reduce((n, l) => n + l.quantity * l.unitPriceCents, 0);
  if (!Number.isSafeInteger(subtotalCents) || subtotalCents > 1_000_000_000) throw new BadRequestException('Valor da comanda acima do limite.');
  if (!Number.isInteger(discountCents) || discountCents < 0 || discountCents > subtotalCents) throw new ConflictException('Desconto incompatível com o valor da comanda.');
  return { subtotalCents, discountCents, totalCents: subtotalCents - discountCents };
}
export function netReceived(payments: Array<{ amountCents: number }>, refunds: Array<{ amountCents: number }>) { return payments.reduce((n, p) => n + p.amountCents, 0) - refunds.reduce((n, r) => n + r.amountCents, 0); }
export const proportionFloor = (amount: number, numerator: number, denominator: number) => denominator ? Number(BigInt(amount) * BigInt(numerator) / BigInt(denominator)) : 0;
export function allocateNet(lines: Array<{ id: string; gross: number }>, discount: number) {
  const gross = lines.reduce((n, l) => n + l.gross, 0);
  if (!gross) return new Map(lines.map(l => [l.id, 0]));
  const portions = lines.map(l => ({ ...l, discount: proportionFloor(discount, l.gross, gross), remainder: Number(BigInt(discount) * BigInt(l.gross) % BigInt(gross)) }));
  let remaining = discount - portions.reduce((n, l) => n + l.discount, 0);
  for (const l of [...portions].sort((a, b) => b.remainder - a.remainder || a.id.localeCompare(b.id))) if (remaining-- > 0) l.discount++;
  return new Map(portions.map(l => [l.id, l.gross - l.discount]));
}
