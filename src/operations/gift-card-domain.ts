import { AuthConfig } from '../auth/auth.config.js';
import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Operator, Sale } from './operations.service.js';
import { netReceived } from './pos-domain.js';
import { queueCustomerEvent } from './operational-messages.js';
export function assertGiftSource(sale: Sale, faceCents: number) {
  const lines = sale.lines.filter((l) => !l.voidedAt);
  if (
    lines.length !== 1 ||
    lines[0].quantity !== 1 ||
    sale.discountCents ||
    sale.totalCents !== faceCents ||
    sale.payments.some((p) => p.method === 'GIFT_CARD')
  )
    throw new ConflictException(
      'Venda de cartão-presente deve conter somente o cartão, pelo valor integral e com recebimento externo ao saldo pré-pago.',
    );
}
export async function creditGiftCard(
  tx: Prisma.TransactionClient,
  actor: Operator,
  sale: Sale,
) {
  const card = await tx.posGiftCard.findUnique({
    where: { sourceSaleId: sale.id },
  });
  if (!card) return;
  assertGiftSource(sale, card.faceCents);
  if (
    card.status !== 'PENDING' ||
    netReceived(sale.payments, sale.refunds) !== card.faceCents
  )
    throw new ConflictException('Crédito exige pagamento integral legítimo.');
  const now = new Date();
  await tx.posGiftCard.update({
    where: { id: card.id },
    data: {
      status: 'ACTIVE',
      balanceCents: card.faceCents,
      creditedAt: now,
      expiresAt: new Date(now.getTime() + card.validityDays * 86400000),
    },
  });
  await tx.posGiftCardMovement.create({
    data: {
      companyId: actor.companyId,
      cardId: card.id,
      sourceKey: 'CREDIT:' + card.id,
      type: 'CREDIT',
      deltaCents: card.faceCents,
      balanceAfterCents: card.faceCents,
      actorId: actor.userId,
      reason: 'Crédito após comanda paga e finalizada.',
    },
  });
  const origin = new AuthConfig().origins()[0];
  if (origin)
    await queueCustomerEvent(
      tx,
      actor.companyId,
      card.recipientId,
      'OP_GIFT_CARD_READY',
      card.id,
      { __giftCardId: card.id, url_agenda: origin + '/painel/cliente' },
    );
}
export async function assertGiftSourceRefund(
  tx: Prisma.TransactionClient,
  companyId: string,
  saleId: string,
  amount: number,
) {
  const card = await tx.posGiftCard.findFirst({
    where: { companyId, sourceSaleId: saleId },
  });
  if (card && card.status !== 'PENDING' && card.balanceCents < amount)
    throw new ConflictException(
      'Parte do cartão já foi utilizada. Restaure os resgates antes de estornar o financiamento correspondente.',
    );
}
export async function refundGiftCard(
  tx: Prisma.TransactionClient,
  actor: Operator,
  receipt: { id: string; saleId: string; method: string },
  refund: { id: string; amountCents: number; reason: string },
) {
  if (receipt.method === 'GIFT_CARD') {
    const redemption = await tx.posGiftCardMovement.findUnique({
      where: { receiptId: receipt.id },
      include: { card: true },
    });
    if (!redemption || redemption.companyId !== actor.companyId)
      throw new ConflictException('Resgate não encontrado.');
    const card = await tx.posGiftCard.update({
      where: { id: redemption.cardId },
      data: { balanceCents: { increment: refund.amountCents } },
    });
    await tx.posGiftCardMovement.create({
      data: {
        companyId: actor.companyId,
        cardId: card.id,
        sourceKey: 'RESTORE:' + refund.id,
        type: 'RESTORE',
        deltaCents: refund.amountCents,
        balanceAfterCents: card.balanceCents,
        refundId: refund.id,
        actorId: actor.userId,
        reason: refund.reason,
      },
    });
    return;
  }
  const card = await tx.posGiftCard.findFirst({
    where: { companyId: actor.companyId, sourceSaleId: receipt.saleId },
  });
  if (!card || card.status === 'PENDING') return;
  const updated = await tx.posGiftCard.update({
    where: { id: card.id },
    data: { balanceCents: { decrement: refund.amountCents } },
  });
  const remaining = netReceived(
    await tx.posReceipt.findMany({
      where: { companyId: actor.companyId, saleId: receipt.saleId },
    }),
    await tx.posRefund.findMany({
      where: { companyId: actor.companyId, saleId: receipt.saleId },
    }),
  );
  if (remaining === 0)
    await tx.posGiftCard.update({
      where: { id: card.id },
      data: { status: 'CANCELLED' },
    });
  await tx.posGiftCardMovement.create({
    data: {
      companyId: actor.companyId,
      cardId: card.id,
      sourceKey: 'SOURCE_REFUND:' + refund.id,
      type: 'SOURCE_REFUND',
      deltaCents: -refund.amountCents,
      balanceAfterCents: updated.balanceCents,
      refundId: refund.id,
      actorId: actor.userId,
      reason: refund.reason,
    },
  });
}
