import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Operator, Sale } from './operations.service.js';
export function materialQuantity(quantityMilli: number, services: number) {
  const total = quantityMilli * services;
  if (!Number.isSafeInteger(total) || total < 1 || total > 1000000000)
    throw new ConflictException('Quantidade de material fora do limite.');
  return total;
}
export async function takeInventory(
  tx: Prisma.TransactionClient,
  input: {
    companyId: string;
    productId: string;
    quantityMilli: number;
    operationId: string;
    lineId?: string;
    includeExpired?: boolean;
  },
) {
  const p = await tx.posProduct.findFirst({
    where: {
      id: input.productId,
      companyId: input.companyId,
      stockManaged: true,
    },
  });
  if (!p || p.stockMilli < input.quantityMilli)
    throw new ConflictException(
      'Estoque insuficiente. Confira entradas e consumo antes de finalizar.',
    );
  const lots = await tx.posInventoryLot.findMany({
    where: {
      companyId: input.companyId,
      productId: p.id,
      quantityMilli: { gt: 0 },
      ...(!input.includeExpired
        ? { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }
        : {}),
    },
    orderBy: [
      { expiresAt: { sort: 'asc', nulls: 'last' } },
      { createdAt: 'asc' },
      { id: 'asc' },
    ],
  });
  if (lots.reduce((n, l) => n + l.quantityMilli, 0) < input.quantityMilli)
    throw new ConflictException(
      'Estoque válido insuficiente; lotes vencidos não podem ser consumidos.',
    );
  let remaining = input.quantityMilli;
  for (const lot of lots) {
    if (!remaining) break;
    const amount = Math.min(remaining, lot.quantityMilli);
    await tx.posInventoryLot.update({
      where: { id: lot.id },
      data: { quantityMilli: { decrement: amount } },
    });
    await tx.posInventoryMovement.create({
      data: {
        companyId: input.companyId,
        operationId: input.operationId,
        lotId: lot.id,
        lineId: input.lineId,
        quantityMilli: -amount,
        costMilliCents: -BigInt(amount) * BigInt(lot.unitCostCents),
      },
    });
    remaining -= amount;
  }
  await tx.posProduct.update({
    where: { id: p.id },
    data: { stockMilli: { decrement: input.quantityMilli } },
  });
}
export async function consumeInventory(
  tx: Prisma.TransactionClient,
  actor: Operator,
  sale: Sale,
) {
  const requirements: Array<{
    productId: string;
    quantityMilli: number;
    lineId: string;
  }> = [];
  for (const line of sale.lines.filter((l) => !l.voidedAt)) {
    if (line.productId) {
      const product = await tx.posProduct.findFirst({
        where: {
          id: line.productId,
          companyId: actor.companyId,
          stockManaged: true,
        },
      });
      if (product)
        requirements.push({
          productId: product.id,
          quantityMilli: materialQuantity(1000, line.quantity),
          lineId: line.id,
        });
    }
    if (line.serviceId && line.completedAt) {
      const recipe = await tx.posServiceMaterial.findMany({
        where: { companyId: actor.companyId, serviceId: line.serviceId },
      });
      for (const r of recipe)
        requirements.push({
          productId: r.productId,
          quantityMilli: materialQuantity(r.quantityMilli, line.quantity),
          lineId: line.id,
        });
    }
  }
  if (!requirements.length) return false;
  if (
    await tx.posInventoryOperation.findUnique({
      where: {
        companyId_sourceKey: {
          companyId: actor.companyId,
          sourceKey: 'SALE:' + sale.id,
        },
      },
    })
  )
    return true;
  const operation = await tx.posInventoryOperation.create({
    data: {
      companyId: actor.companyId,
      sourceKey: 'SALE:' + sale.id,
      requestHash: sale.id,
      type: 'SALE_FINALIZED',
      actorId: actor.userId,
      reason: 'Baixa de produtos e materiais após comanda finalizada.',
    },
  });
  for (const item of requirements)
    await takeInventory(tx, {
      ...item,
      companyId: actor.companyId,
      operationId: operation.id,
    });
  return true;
}
