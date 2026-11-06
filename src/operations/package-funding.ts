import type { Prisma } from '@prisma/client';
import { netReceived, proportionFloor } from './pos-domain.js';
export type CashSale = {
  id: string;
  companyId: string;
  totalCents: number;
  payments: Array<{ amountCents: number }>;
  refunds: Array<{ amountCents: number }>;
};
export async function packageFunding(
  tx: Pick<Prisma.TransactionClient, 'posPackageUse'>,
  companyId: string,
  saleId: string,
) {
  const uses = await tx.posPackageUse.findMany({
    where: { companyId, saleId, status: { in: ['RESERVED', 'CONSUMED'] } },
    include: {
      session: {
        include: {
          wallet: {
            include: {
              sourceSale: { include: { payments: true, refunds: true } },
            },
          },
        },
      },
    },
  });
  return new Map(
    uses.map((u) => {
      const wallet = u.session.wallet,
        source = wallet.sourceSale,
        settled = Math.min(
          source.totalCents,
          Math.max(0, netReceived(source.payments, source.refunds)),
        );
      const value =
        u.status === 'RESERVED' &&
        (wallet.status !== 'ACTIVE' || wallet.expiresAt <= new Date())
          ? 0
          : source.totalCents
            ? proportionFloor(u.allocatedCents, settled, source.totalCents)
            : 0;
      return [
        u.lineId,
        { valueCents: value, originalCents: u.allocatedCents, useId: u.id },
      ];
    }),
  );
}
export async function effectiveLoyaltyValue(
  tx: Pick<Prisma.TransactionClient, 'posPackageUse' | 'posPackageWallet'>,
  sale: CashSale,
) {
  const funding = await packageFunding(tx, sale.companyId, sale.id),
    prepaid = await tx.posPackageWallet.aggregate({
      where: { companyId: sale.companyId, sourceSaleId: sale.id },
      _sum: { originalCents: true },
    }),
    cash = Math.max(
      0,
      Math.min(sale.totalCents, netReceived(sale.payments, sale.refunds)),
    ),
    cashBasis = Math.max(
      0,
      sale.totalCents - (prepaid._sum.originalCents ?? 0),
    );
  return (
    (sale.totalCents ? proportionFloor(cashBasis, cash, sale.totalCents) : 0) +
    [...funding.values()].reduce((n, v) => n + v.valueCents, 0)
  );
}

export function weightedCents(amount: number, weights: number[]) {
  const total = weights.reduce((n, w) => n + w, 0),
    actual = total ? weights : weights.map(() => 1),
    divisor = total || actual.length;
  if (!divisor) return [];
  const rows = actual.map((w, i) => ({
    i,
    amount: proportionFloor(amount, w, divisor),
    remainder: (BigInt(amount) * BigInt(w)) % BigInt(divisor),
  }));
  let rest = amount - rows.reduce((n, r) => n + r.amount, 0);
  for (const r of [...rows].sort((a, b) =>
    a.remainder === b.remainder
      ? a.i - b.i
      : a.remainder > b.remainder
        ? -1
        : 1,
  ))
    if (rest-- > 0) r.amount++;
  return rows.map((r) => r.amount);
}
