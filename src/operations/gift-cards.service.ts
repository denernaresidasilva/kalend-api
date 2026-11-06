import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { SecretVault } from '../billing/secret-vault.js';
import { EntitlementsService } from '../billing/entitlements.service.js';
import { OperationsService, type Operator } from './operations.service.js';
import { object, string, uuid, integer } from '../common/validation.js';
import { netReceived, terminalSale } from './pos-domain.js';
import { saleEvent } from './operational-messages.js';
const cashiers = ['OWNER', 'ADMIN', 'RECEPTIONIST'];
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
@Injectable()
export class GiftCardsService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(OperationsService) private readonly ops: OperationsService,
    @Inject(EntitlementsService)
    private readonly entitlements: EntitlementsService,
    @Inject(SecretVault) private readonly vault: SecretVault,
  ) {}
  async status(actor: Operator) {
    const sub = await this.entitlements.current(actor.companyId);
    return {
      entitled: sub.plan.features.some(
        (f) => f.code === 'gift_cards' && f.enabled,
      ),
      redemptionPolicy: 'IDENTIFIED_RECIPIENT_SERVICES_ONLY',
    };
  }
  async list(actor: Operator, own = false) {
    if (
      (!own && !cashiers.includes(actor.role)) ||
      (own && actor.role !== 'CLIENT')
    )
      throw new ForbiddenException();
    return this.db.posGiftCard.findMany({
      where: {
        companyId: actor.companyId,
        ...(own
          ? { recipient: { userId: actor.userId }, status: { not: 'PENDING' } }
          : {}),
      },
      select: {
        id: true,
        sourceSaleId: true,
        recipientId: true,
        recipient: { select: { name: true } },
        message: true,
        suffix: true,
        faceCents: true,
        balanceCents: true,
        status: true,
        expiresAt: true,
        creditedAt: true,
        createdAt: true,
        company: { select: { timezone: true } },
        movements: {
          select: {
            type: true,
            deltaCents: true,
            balanceAfterCents: true,
            reason: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 100,
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }
  async sell(actor: Operator, input: unknown) {
    const b = object(input, [
        'customerId',
        'recipientId',
        'amountCents',
        'validityDays',
        'message',
        'idempotencyKey',
      ]),
      customerId = uuid(b.customerId),
      recipientId = uuid(b.recipientId),
      key = uuid(b.idempotencyKey),
      message =
        b.message === undefined ? '' : string(b.message, 'message', 1000);
    integer(b.amountCents, 'amountCents', 1, 100000000);
    integer(b.validityDays, 'validityDays', 1, 3650);
    const hash = digest(
      JSON.stringify({
        customerId,
        recipientId,
        amountCents: b.amountCents,
        validityDays: b.validityDays,
        message,
      }),
    );
    return this.ops.change(actor, cashiers, async (tx) => {
      await this.entitlements.assertFeature(actor.companyId, 'gift_cards', tx);
      const old = await tx.posSale.findUnique({
        where: {
          companyId_idempotencyKey: {
            companyId: actor.companyId,
            idempotencyKey: key,
          },
        },
      });
      if (old) {
        if (old.requestHash !== hash)
          throw new ConflictException('Chave já utilizada.');
        return this.ops.sale(tx, actor, old.id);
      }
      for (const id of [customerId, recipientId])
        if (
          !(await tx.customerProfile.findFirst({
            where: { id, companyId: actor.companyId },
          }))
        )
          throw new NotFoundException('Cliente não encontrado.');
      const cardId = randomUUID(),
        code = randomBytes(24).toString('base64url'),
        encrypted = this.vault.encrypt(
          code,
          'gift-card:' + actor.companyId + ':' + cardId,
        );
      const sale = await tx.posSale.create({
          data: {
            companyId: actor.companyId,
            customerId,
            idempotencyKey: key,
            requestHash: hash,
            openedById: actor.userId,
            subtotalCents: b.amountCents as number,
            totalCents: b.amountCents as number,
          },
        }),
        product = await tx.posProduct.create({
          data: {
            companyId: actor.companyId,
            name: 'Cartão-presente digital · ' + code.slice(-4),
            priceCents: b.amountCents as number,
            active: false,
          },
        });
      await tx.posSaleLine.create({
        data: {
          companyId: actor.companyId,
          saleId: sale.id,
          productId: product.id,
          name: product.name,
          unitPriceCents: b.amountCents as number,
          quantity: 1,
        },
      });
      await tx.posGiftCard.create({
        data: {
          id: cardId,
          companyId: actor.companyId,
          sourceSaleId: sale.id,
          productId: product.id,
          recipientId,
          message,
          faceCents: b.amountCents as number,
          validityDays: b.validityDays as number,
          codeHash: digest(code),
          codeEncrypted: encrypted,
          suffix: code.slice(-4),
        },
      });
      await tx.posAudit.create({
        data: {
          companyId: actor.companyId,
          saleId: sale.id,
          actorId: actor.userId,
          action: 'GIFT_CARD_SALE_CREATED',
          detail: { cardId, recipientId },
        },
      });
      await this.ops.notify(tx, actor.companyId);
      return this.ops.sale(tx, actor, sale.id);
    });
  }
  async code(actor: Operator, id: string) {
    return this.ops.change(actor, [...cashiers, 'CLIENT'], async (tx) => {
      const card = await tx.posGiftCard.findFirst({
        where: {
          id,
          companyId: actor.companyId,
          ...(actor.role === 'CLIENT'
            ? { recipient: { userId: actor.userId } }
            : {}),
        },
      });
      if (
        !card ||
        card.status !== 'ACTIVE' ||
        !card.creditedAt ||
        !card.expiresAt ||
        card.expiresAt <= new Date() ||
        card.balanceCents <= 0
      )
        throw new NotFoundException('Cartão válido não encontrado.');
      await tx.posAudit.create({
        data: {
          companyId: actor.companyId,
          actorId: actor.userId,
          saleId: card.sourceSaleId,
          action: 'GIFT_CARD_CODE_VIEWED',
          detail: { cardId: card.id },
        },
      });
      return {
        code: this.vault.decrypt(
          card.codeEncrypted,
          'gift-card:' + actor.companyId + ':' + card.id,
        ),
      };
    });
  }
  async redeem(actor: Operator, saleId: string, input: unknown) {
    const b = object(input, ['code', 'amountCents', 'idempotencyKey']),
      code = string(b.code, 'code', 64),
      key = uuid(b.idempotencyKey);
    if (!/^[A-Za-z0-9_-]{32}$/.test(code))
      throw new BadRequestException('Código inválido.');
    integer(b.amountCents, 'amountCents', 1, 100000000);
    const hash = digest(
      JSON.stringify({
        saleId,
        codeHash: digest(code),
        amountCents: b.amountCents,
      }),
    );
    return this.ops.change(actor, cashiers, async (tx) => {
      await this.entitlements.assertFeature(actor.companyId, 'gift_cards', tx);
      const old = await tx.posGiftCardMovement.findUnique({
        where: {
          companyId_sourceKey: {
            companyId: actor.companyId,
            sourceKey: 'REDEEM:' + key,
          },
        },
      });
      if (old) {
        if (old.requestHash !== hash)
          throw new ConflictException('Chave já utilizada.');
        return old;
      }
      const card = await tx.posGiftCard.findFirst({
        where: {
          companyId: actor.companyId,
          codeHash: digest(code),
          status: 'ACTIVE',
          creditedAt: { not: null },
          expiresAt: { gt: new Date() },
          balanceCents: { gte: b.amountCents as number },
        },
      });
      if (!card)
        throw new ConflictException(
          'Cartão indisponível ou saldo insuficiente.',
        );
      const sale = await this.ops.sale(tx, actor, saleId),
        lines = sale.lines.filter((l) => !l.voidedAt);
      if (
        terminalSale(sale.status) ||
        sale.customerId !== card.recipientId ||
        !lines.length ||
        lines.some((l) => !l.serviceId) ||
        (await tx.posPackageUse.count({
          where: { companyId: actor.companyId, saleId, status: 'RESERVED' },
        }))
      )
        throw new ConflictException(
          'Resgate exige comanda de serviços do destinatário identificado, sem sessões de pacote.',
        );
      if (
        netReceived(sale.payments, sale.refunds) + (b.amountCents as number) >
        sale.totalCents
      )
        throw new ConflictException('Resgate maior que o saldo da comanda.');
      const cash = await tx.posCashSession.findFirst({
        where: { companyId: actor.companyId, closedAt: null },
      });
      if (!cash) throw new ConflictException('Abra o caixa.');
      const balance = card.balanceCents - (b.amountCents as number);
      await tx.posGiftCard.update({
        where: { id: card.id },
        data: { balanceCents: balance },
      });
      const receipt = await tx.posReceipt.create({
        data: {
          companyId: actor.companyId,
          saleId,
          cashSessionId: cash.id,
          idempotencyKey: key,
          amountCents: b.amountCents as number,
          method: 'GIFT_CARD',
          reference: 'Cartão-presente · ' + card.suffix,
          recordedById: actor.userId,
        },
      });
      const movement = await tx.posGiftCardMovement.create({
        data: {
          companyId: actor.companyId,
          cardId: card.id,
          sourceKey: 'REDEEM:' + key,
          requestHash: hash,
          type: 'REDEEM',
          deltaCents: -(b.amountCents as number),
          balanceAfterCents: balance,
          receiptId: receipt.id,
          actorId: actor.userId,
          reason: 'Resgate em serviços do destinatário identificado.',
        },
      });
      await saleEvent(tx, sale, 'OP_RECEIPT_RECORDED', receipt.id, {
        __factId: receipt.id,
      });
      await this.ops.notify(tx, actor.companyId);
      return movement;
    });
  }
}
