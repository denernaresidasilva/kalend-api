import {
  Inject,
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { GatewayRegistry, gatewayName } from './gateway.provider.js';
import type {
  Gateway,
  ProviderEvent,
  VerifiedEvent,
  SubscriptionEvent,
} from './gateway.types.js';
import { GatewaysService } from './gateways.service.js';
import { safeEventSelect, integer, string } from '../common/validation.js';
import { nextPeriod } from '../common/period.js';
import { graceEnd, suspendIfUnentitled } from './commercial-policy.js';
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
  ) {
    if (!raw || raw.length > 262144)
      throw new BadRequestException('Payload inválido.');
    const context = await this.gateways.context(gateway, false);
    const events = await this.registry
      .get(gateway)
      .verifyWebhook(raw, headers, context, query);
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
              ? await this.subscription(tx, gateway, event)
              : await this.payment(tx, gateway, event);
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
          error instanceof Prisma.PrismaClientKnownRequestError &&
          ['P2034', 'P2002'].includes(error.code) &&
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
  private async subscription(
    tx: Prisma.TransactionClient,
    gateway: Gateway,
    e: SubscriptionEvent,
  ) {
    let sub = await tx.subscription.findUnique({
      where: {
        gateway_environment_externalSubscriptionId: {
          gateway,
          environment: e.environment,
          externalSubscriptionId: e.externalSubscriptionId,
        },
      },
    });
    if (!sub && e.externalReference)
      sub = await tx.subscription.findFirst({
        where: { id: e.externalReference, gateway, environment: e.environment },
      });
    if (!sub && e.externalReference) {
      const intent = await tx.payment.findFirst({
        where: {
          id: e.externalReference,
          gateway,
          environment: e.environment,
          recurring: true,
        },
        include: { subscription: true },
      });
      sub = intent?.subscription ?? null;
    }
    if (
      !sub ||
      (sub.externalSubscriptionId &&
        sub.externalSubscriptionId !== e.externalSubscriptionId)
    )
      throw new ConflictException('SUBSCRIPTION_REFERENCE_MISMATCH');
    const now = new Date();
    await tx.subscription.update({
      where: { id: sub.id },
      data: {
        externalSubscriptionId: e.externalSubscriptionId,
        ...(e.status === 'CANCELED'
          ? { status: 'CANCELED', canceledAt: now, endedAt: now }
          : e.status === 'SUSPENDED'
            ? { status: 'SUSPENDED' }
            : e.status === 'PAST_DUE' && sub.status !== 'CANCELED'
              ? {
                  status: 'PAST_DUE',
                  graceEndsAt:
                    sub.graceEndsAt ?? graceEnd(sub.currentPeriodEnd ?? now),
                }
              : {}),
        cancelAtPeriodEnd: e.cancelAtPeriodEnd,
      },
    });
    // Subscription ACTIVE means mandate enabled; only a verified payment grants paid entitlement.
    if (['CANCELED', 'SUSPENDED', 'PAST_DUE'].includes(e.status))
      await suspendIfUnentitled(tx, sub.companyId, now);
    return { companyId: sub.companyId };
  }
  private async payment(
    tx: Prisma.TransactionClient,
    gateway: Gateway,
    e: VerifiedEvent,
  ) {
    const externalWhere = {
      gateway_environment_externalPaymentId: {
        gateway,
        environment: e.environment,
        externalPaymentId: e.externalPaymentId,
      },
    };
    let p = await tx.payment.findUnique({
      where: externalWhere,
      include: { subscription: true },
    });
    if (!p && e.externalReference)
      p = await tx.payment.findFirst({
        where: {
          id: e.externalReference,
          gateway,
          environment: e.environment,
          OR: [
            { externalPaymentId: null },
            { externalPaymentId: e.externalPaymentId },
          ],
        },
        include: { subscription: true },
      });
    if (!p && e.externalSubscriptionId) {
      const sub = await tx.subscription.findUnique({
        where: {
          gateway_environment_externalSubscriptionId: {
            gateway,
            environment: e.environment,
            externalSubscriptionId: e.externalSubscriptionId,
          },
        },
      });
      if (sub && sub.expectedAmountCents !== null) {
        // First charge binds to the pending intent; later invoices receive distinct immutable periods.
        p = await tx.payment.findFirst({
          where: { subscriptionId: sub.id, externalPaymentId: null },
          include: { subscription: true },
          orderBy: { createdAt: 'asc' },
        });
        if (!p) {
          if (e.cycle !== undefined) {
            integer(e.cycle, 'cycle', 1, 1200);
            const first = await tx.payment.findFirst({
              where: { subscriptionId: sub.id },
              orderBy: { createdAt: 'asc' },
            });
            if (!first?.periodStart)
              throw new ConflictException('RENEWAL_PERIOD_REQUIRED');
            let start = first.periodStart;
            for (let n = 1; n < e.cycle; n++)
              start = nextPeriod(start, sub.billingInterval);
            e = {
              ...e,
              periodStart: start.toISOString(),
              periodEnd: nextPeriod(start, sub.billingInterval).toISOString(),
            };
          }
          if (!e.periodStart)
            throw new ConflictException('RENEWAL_PERIOD_REQUIRED');
          const start = new Date(e.periodStart),
            end = e.periodEnd
              ? new Date(e.periodEnd)
              : nextPeriod(start, sub.billingInterval);
          if (
            !Number.isFinite(start.getTime()) ||
            !Number.isFinite(end.getTime()) ||
            end <= start
          )
            throw new ConflictException('RENEWAL_PERIOD_INVALID');
          p = await tx.payment.create({
            data: {
              companyId: sub.companyId,
              subscriptionId: sub.id,
              planId: sub.planId,
              billingInterval: sub.billingInterval,
              gateway,
              environment: e.environment,
              amountCents: sub.expectedAmountCents,
              currency: sub.currency,
              externalPaymentId: e.externalPaymentId,
              status: 'PENDING',
              creationState: 'CREATED',
              recurring: true,
              periodStart: start,
              periodEnd: end,
            },
            include: { subscription: true },
          });
        }
      }
    }
    if (
      !p ||
      !p.subscription ||
      p.gateway !== gateway ||
      p.environment !== e.environment ||
      (p.subscription.environment !== null &&
        p.subscription.environment !== undefined &&
        p.subscription.environment !== e.environment) ||
      p.subscription.companyId !== p.companyId ||
      p.subscription.planId !== p.planId ||
      p.amountCents !== e.amountCents ||
      p.currency !== e.currency ||
      (e.companyId && e.companyId !== p.companyId) ||
      (e.planId && e.planId !== p.planId) ||
      (p.externalPaymentId && p.externalPaymentId !== e.externalPaymentId) ||
      (e.externalSubscriptionId &&
        p.subscription.externalSubscriptionId &&
        e.externalSubscriptionId !== p.subscription.externalSubscriptionId)
    )
      throw new ConflictException('PAYMENT_REFERENCE_MISMATCH');
    const sub = p.subscription,
      now = new Date();
    if (
      gateway === 'PAGBANK' &&
      p.recurring &&
      e.externalPaymentId.startsWith('CHAR_')
    )
      return { paymentId: p.id, companyId: p.companyId }; // recurring invoices are the canonical financial resource
    if (e.externalSubscriptionId && !sub.externalSubscriptionId)
      await tx.subscription.update({
        where: { id: sub.id },
        data: { externalSubscriptionId: e.externalSubscriptionId },
      });
    const referenceAllowed =
      !e.externalReference ||
      e.externalReference === p.id ||
      e.externalReference === sub.id ||
      (p.recurring && e.externalSubscriptionId === sub.externalSubscriptionId);
    if (!referenceAllowed)
      throw new ConflictException('PAYMENT_REFERENCE_MISMATCH');
    const refund =
      e.status === 'REFUNDED'
        ? (e.refundIsDelta ? p.refundedAmountCents : 0) +
          (e.refundedAmountCents ?? e.amountCents)
        : p.refundedAmountCents;
    if (refund > p.amountCents)
      throw new ConflictException('REFUND_AMOUNT_MISMATCH');
    const allowed =
      !['APPROVED', 'REFUNDED'].includes(p.status) ||
      (e.status === 'REFUNDED' && refund > p.refundedAmountCents);
    if (allowed) {
      const fullRefund = e.status === 'REFUNDED' && refund === p.amountCents;
      const status =
        e.status === 'REFUNDED' && !fullRefund ? 'APPROVED' : e.status;
      await tx.payment.update({
        where: { id: p.id },
        data: {
          externalPaymentId: e.externalPaymentId,
          creationState: 'CREATED',
          status,
          refundedAmountCents: refund,
          paidAt: e.status === 'APPROVED' ? (p.paidAt ?? now) : undefined,
          refundedAt: e.status === 'REFUNDED' ? now : undefined,
        },
      });
      if (e.status === 'APPROVED' && sub.status !== 'CANCELED') {
        if (!p.periodStart || !p.periodEnd)
          throw new ConflictException('PAYMENT_PERIOD_MISSING');
        if (
          (!sub.currentPeriodEnd || p.periodEnd >= sub.currentPeriodEnd) &&
          p.periodEnd > now
        ) {
          // Competing checkouts cannot silently overwrite an already paid plan.
          const newer = await tx.subscription.findFirst({
            where: {
              companyId: p.companyId,
              id: { not: sub.id },
              status: 'ACTIVE',
              currentPeriodEnd: { gt: now },
              createdAt: { gt: sub.createdAt },
            },
            select: { id: true },
          });
          if (!newer) {
            await tx.subscription.updateMany({
              where: {
                companyId: p.companyId,
                id: { not: sub.id },
                status: 'TRIALING',
              },
              data: { status: 'EXPIRED', endedAt: now },
            });
            await tx.subscription.update({
              where: { id: sub.id },
              data: {
                status: 'ACTIVE',
                gateway,
                environment: e.environment,
                currentPeriodStart: p.periodStart,
                currentPeriodEnd: p.periodEnd,
                graceEndsAt: null,
                endedAt: null,
              },
            });
            await tx.company.update({
              where: { id: p.companyId },
              data: { status: 'ACTIVE', isActive: true },
            });
          }
        }
      }
      if (
        sub.status !== 'CANCELED' &&
        ((fullRefund &&
          p.periodEnd?.getTime() === sub.currentPeriodEnd?.getTime()) ||
          (['FAILED', 'OVERDUE'].includes(e.status) &&
            (!sub.currentPeriodEnd || sub.currentPeriodEnd <= now)))
      ) {
        await tx.subscription.update({
          where: { id: sub.id },
          data: {
            status: fullRefund ? 'SUSPENDED' : 'PAST_DUE',
            graceEndsAt: fullRefund
              ? null
              : (sub.graceEndsAt ?? graceEnd(sub.currentPeriodEnd ?? now)),
          },
        });
        await suspendIfUnentitled(tx, p.companyId, now);
      }
    }
    return { paymentId: p.id, companyId: p.companyId };
  }
}
