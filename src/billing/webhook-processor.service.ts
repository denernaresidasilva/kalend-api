import { retryableBillingConflict } from './transaction-conflict.js';
import {
  Inject,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { GatewayRegistry, gatewayName } from './gateway.provider.js';
import type { Gateway, ProviderEvent } from './gateway.types.js';
import { GatewaysService } from './gateways.service.js';
import { safeEventSelect, integer, string } from '../common/validation.js';
import { BillingDomain } from './billing-domain.js';
import type { pagbankWebhookDiagnostics } from './pagbank-webhook-diagnostics.js';
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
    query: Record<string, unknown> = {},
    diagnostics?: ReturnType<typeof pagbankWebhookDiagnostics>,
  ) {
    if (!raw || raw.length > 262144)
      throw new BadRequestException('Payload inválido.');
    const context = await this.gateways.context(gateway, false);
    let events: ProviderEvent[];
    try {
      events = await this.registry
        .get(gateway)
        .verifyWebhook(raw, headers, context, query);
    } catch (error) {
      if (
        gateway === 'PAGBANK' &&
        diagnostics &&
        error instanceof UnauthorizedException &&
        (error.getResponse() as { reason?: string }).reason ===
          'SIGNATURE_MISSING'
      ) {
        new Logger('PagBankWebhook').warn({
          event: 'PAGBANK_WEBHOOK_SIGNATURE_MISSING_DIAGNOSTICS',
          environment: context.environment,
          ...diagnostics,
        });
      }
      throw error;
    }
    const results: unknown[] = [];
    for (const e of events) {
      if (e.environment !== context.environment)
        throw new BadRequestException('WEBHOOK_ENVIRONMENT_MISMATCH');
      results.push(await this.processVerified(gateway, e));
    }
    return { received: true, results };
  }
  async reprocess(id: string) {
    const row = await this.prisma.webhookEvent.findUnique({
      where: { id },
      include: { payment: true },
    });
    if (!row) throw new NotFoundException('Evento não encontrado.');
    if (row.status !== 'FAILED')
      throw new ConflictException('Evento não pode ser reprocessado.');
    const gateway = gatewayName(row.gateway),
      context = await this.gateways.context(gateway, false);
    if (row.environment !== context.environment)
      throw new ConflictException('WEBHOOK_ENVIRONMENT_MISMATCH');
    const payload = row.payload as Record<string, unknown>;
    const provider = this.registry.get(gateway);
    const external =
      row.payment?.externalPaymentId ?? payload.externalPaymentId;
    const current =
      typeof payload.externalRefundId === 'string' && provider.getRefund
        ? await provider.getRefund(payload.externalRefundId, context)
        : typeof external === 'string'
          ? await provider.getPayment(external, context)
          : typeof payload.externalSubscriptionId === 'string' &&
              provider.getSubscription
            ? await provider.getSubscription(
                payload.externalSubscriptionId,
                context,
              )
            : null;
    if (!current) throw new ConflictException('GATEWAY_REFERENCE_REQUIRED');
    return this.processVerified(gateway, {
      ...current,
      eventId: row.externalEventId,
    });
  }
  async processVerified(gateway: Gateway, event: ProviderEvent) {
    // QA enters only through the authenticated simulator, never the provider path.
    gatewayName(gateway);
    string(event.eventId, 'eventId', 512);
    string(event.type, 'type');
    if (!['SANDBOX', 'PRODUCTION'].includes(event.environment))
      throw new BadRequestException('Evento inválido.');
    const isSub = 'kind' in event;
    if (!isSub) {
      string(event.externalPaymentId, 'externalPaymentId');
      integer(event.amountCents, 'amountCents');
      if (
        event.currency !== 'BRL' ||
        ![
          'PENDING',
          'APPROVED',
          'FAILED',
          'OVERDUE',
          'REFUNDED',
          'CANCELED',
        ].includes(event.status)
      )
        throw new BadRequestException('Evento inválido.');
      if (event.refundedAmountCents !== undefined)
        integer(
          event.refundedAmountCents,
          'refundedAmountCents',
          0,
          event.amountCents,
        );
    } else if (
      !['PENDING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'SUSPENDED'].includes(
        event.status,
      )
    )
      throw new BadRequestException('Evento inválido.');
    // Persist a strict normalized allowlist, never raw bodies or provider errors.
    const payload = isSub
      ? {
          externalSubscriptionId: event.externalSubscriptionId,
          status: event.status,
        }
      : {
          externalPaymentId: event.externalPaymentId,
          status: event.status,
          amountCents: event.amountCents,
          currency: event.currency,
          ...(event.externalRefundId
            ? { externalRefundId: event.externalRefundId }
            : {}),
        };
    const row = await this.prisma.webhookEvent.upsert({
      where: {
        gateway_environment_externalEventId: {
          gateway,
          environment: event.environment,
          externalEventId: event.eventId,
        },
      },
      update: {},
      create: {
        gateway,
        environment: event.environment,
        externalEventId: event.eventId,
        eventType: event.type,
        payload,
      },
    });
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
            const result = isSub
              ? await new BillingDomain().subscription(tx, gateway, event)
              : await new BillingDomain().payment(tx, gateway, event);
            return tx.webhookEvent.update({
              where: { id: row.id },
              data: { status: 'PROCESSED', processedAt: new Date(), ...result },
              select: safeEventSelect,
            });
          },
          { isolationLevel: 'Serializable' },
        );
      } catch (error) {
        if (
          retryableBillingConflict(error) &&
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
