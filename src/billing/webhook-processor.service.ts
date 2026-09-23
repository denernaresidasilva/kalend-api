import { Inject } from '@nestjs/common';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { GatewayRegistry, gatewayName } from './gateway.provider.js';
import type { Gateway, VerifiedEvent } from './gateway.provider.js';
import { GatewaysService } from './gateways.service.js';
import { safeEventSelect, integer, string } from '../common/validation.js';
@Injectable()
export class WebhookProcessor {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(GatewayRegistry) private readonly registry: GatewayRegistry,
    @Inject(GatewaysService) private readonly gateways: GatewaysService,
  ) {}
  async receive(
    gateway: Gateway,
    raw: Buffer | undefined,
    headers: Record<string, string | string[] | undefined>,
  ) {
    if (!raw || raw.length > 262144)
      throw new BadRequestException('Payload inválido.');
    const provider = this.registry.get(gateway);
    const context = await this.gateways.context(gateway);
    const event = await provider.verifyWebhook(raw, headers, context);
    if (event.environment !== context.environment)
      throw new BadRequestException('WEBHOOK_ENVIRONMENT_MISMATCH');
    return this.processVerified(gateway, event);
  }
  async reprocess(id: string) {
    const stored = await this.prisma.webhookEvent.findUnique({
      where: { id },
      include: { payment: true },
    });
    if (!stored) throw new NotFoundException('Evento não encontrado.');
    if (stored.status !== 'FAILED' || !stored.payment?.externalPaymentId)
      throw new ConflictException('Evento não pode ser reprocessado.');
    const gateway = gatewayName(stored.gateway);
    const provider = this.registry.get(gateway);
    const context = await this.gateways.context(gateway);
    if (stored.environment !== context.environment)
      throw new ConflictException('WEBHOOK_ENVIRONMENT_MISMATCH');
    const current = await provider.getPayment(
      stored.payment.externalPaymentId,
      context,
    );
    if (current.environment !== context.environment)
      throw new ConflictException('WEBHOOK_ENVIRONMENT_MISMATCH');
    return this.processVerified(gateway, {
      ...current,
      eventId: stored.externalEventId,
      type: stored.eventType ?? current.type,
    });
  }
  /** Internal only: providers MUST verify signature/account/environment before this boundary. */
  async processVerified(gateway: Gateway, event: VerifiedEvent) {
    string(event.eventId, 'eventId');
    string(event.type, 'type');
    string(event.externalPaymentId, 'externalPaymentId');
    integer(event.amountCents, 'amountCents');
    if (
      !['SANDBOX', 'PRODUCTION'].includes(event.environment) ||
      event.currency !== 'BRL' ||
      !['APPROVED', 'FAILED', 'REFUNDED', 'CANCELED'].includes(event.status)
    )
      throw new BadRequestException('Evento inválido.');
    const payment = await this.prisma.payment.findUnique({
      where: {
        gateway_externalPaymentId: {
          gateway,
          externalPaymentId: event.externalPaymentId,
        },
      },
    });
    // Keep only a normalized allowlist; never persist provider headers, signatures, or raw secrets.
    const payload = {
      externalPaymentId: event.externalPaymentId,
      status: event.status,
      amountCents: event.amountCents,
      currency: event.currency,
    };
    const row = await this.prisma.webhookEvent.upsert({
      where: {
        gateway_externalEventId: { gateway, externalEventId: event.eventId },
      },
      update: {},
      create: {
        gateway,
        environment: event.environment,
        externalEventId: event.eventId,
        eventType: event.type,
        payload,
        paymentId: payment?.id,
        companyId: payment?.companyId,
      },
    });
    if (row.environment !== event.environment)
      throw new ConflictException('WEBHOOK_ENVIRONMENT_MISMATCH');
    if (row.status === 'PROCESSED' || row.status === 'IGNORED')
      return { id: row.id, status: row.status, duplicate: true };
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            const claimed = await tx.webhookEvent.updateMany({
              where: { id: row.id, status: { in: ['RECEIVED', 'FAILED'] } },
              data: {
                status: 'PROCESSING',
                attempts: { increment: 1 },
                errorMessage: null,
              },
            });
            if (!claimed.count) return { id: row.id, duplicate: true };
            const p = await tx.payment.findUnique({
              where: {
                gateway_externalPaymentId: {
                  gateway,
                  externalPaymentId: event.externalPaymentId,
                },
              },
              include: { subscription: true },
            });
            if (
              !p ||
              !p.subscription ||
              p.environment !== event.environment ||
              p.subscription.companyId !== p.companyId ||
              p.subscription.planId !== p.planId ||
              p.amountCents !== event.amountCents ||
              p.currency !== event.currency ||
              (row.paymentId && row.paymentId !== p.id)
            )
              throw new ConflictException('PAYMENT_REFERENCE_MISMATCH');
            const sub = p.subscription;
            const now = new Date();
            const allowed =
              p.status === 'PENDING' ||
              (p.status === 'APPROVED' && event.status === 'REFUNDED');
            if (allowed) {
              await tx.payment.update({
                where: { id: p.id },
                data: {
                  status: event.status,
                  paidAt: event.status === 'APPROVED' ? now : undefined,
                  refundedAt: event.status === 'REFUNDED' ? now : undefined,
                },
              });
              if (
                event.status === 'APPROVED' &&
                !['CANCELED', 'EXPIRED'].includes(sub.status)
              ) {
                if (!p.periodStart || !p.periodEnd)
                  throw new ConflictException('PAYMENT_PERIOD_MISSING');
                // Fixed period per charge: multiple event IDs cannot extend the same charge twice.
                if (
                  !sub.currentPeriodEnd ||
                  p.periodEnd > sub.currentPeriodEnd
                ) {
                  await tx.subscription.update({
                    where: { id: sub.id },
                    data: {
                      status: 'ACTIVE',
                      gateway,
                      currentPeriodStart: p.periodStart,
                      currentPeriodEnd: p.periodEnd,
                    },
                  });
                  await tx.company.update({
                    where: { id: p.companyId },
                    data: { status: 'ACTIVE', isActive: true },
                  });
                }
              }
              // Failure never grants access. Refunds revoke only the exact current paid period.
              if (
                event.status === 'REFUNDED' &&
                p.periodEnd !== null &&
                p.periodEnd?.getTime() === sub.currentPeriodEnd?.getTime()
              ) {
                await tx.subscription.update({
                  where: { id: sub.id },
                  data: { status: 'PAST_DUE' },
                });
                const other = await tx.subscription.count({
                  where: {
                    companyId: p.companyId,
                    id: { not: sub.id },
                    OR: [
                      { status: 'ACTIVE', currentPeriodEnd: { gt: now } },
                      { status: 'TRIALING', trialEndsAt: { gt: now } },
                    ],
                  },
                });
                if (!other)
                  await tx.company.update({
                    where: { id: p.companyId },
                    data: { status: 'SUSPENDED', isActive: false },
                  });
              }
            }
            return tx.webhookEvent.update({
              where: { id: row.id },
              data: {
                status: 'PROCESSED',
                processedAt: now,
                paymentId: p.id,
                companyId: p.companyId,
              },
              select: safeEventSelect,
            });
          },
          { isolationLevel: 'Serializable' },
        );
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2034' &&
          attempt < 2
        )
          continue;
        await this.prisma.webhookEvent.updateMany({
          where: { id: row.id, status: { in: ['RECEIVED', 'FAILED'] } },
          data: {
            status: 'FAILED',
            errorMessage: 'PROCESSING_FAILED',
            attempts: { increment: 1 },
          },
        });
        throw new ConflictException('WEBHOOK_PROCESSING_FAILED');
      }
    }
  }
}
