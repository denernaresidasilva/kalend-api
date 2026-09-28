import {
  Inject,
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Payment } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { object, string, uuid, boolean } from '../common/validation.js';
import { nextPeriod } from '../common/period.js';
import { GatewayRegistry, gatewayName } from './gateway.provider.js';
import { GatewaysService } from './gateways.service.js';
@Injectable()
export class PaymentsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(GatewayRegistry) private readonly registry: GatewayRegistry,
    @Inject(GatewaysService) private readonly gateways: GatewaysService,
  ) {}
  /** Legacy Super Admin contract, still bound to the requested subscription and plan. */
  async create(input: unknown) {
    const d = object(input, [
      'companyId',
      'subscriptionId',
      'planId',
      'gateway',
      'idempotencyKey',
    ]);
    const companyId = uuid(d.companyId),
      subscriptionId = uuid(d.subscriptionId),
      planId = uuid(d.planId);
    const sub = await this.prisma.subscription.findFirst({
      where: { id: subscriptionId, companyId, planId },
    });
    if (!sub)
      throw new NotFoundException(
        'Assinatura não encontrada para empresa/plano.',
      );
    return this.checkout(
      companyId,
      {
        planId,
        gateway: d.gateway,
        idempotencyKey: d.idempotencyKey,
        billingInterval: sub.billingInterval,
      },
      subscriptionId,
    );
  }
  async checkout(
    companyId: string,
    input: unknown,
    legacySubscriptionId?: string,
  ) {
    const d = object(input, [
      'planId',
      'gateway',
      'billingInterval',
      'idempotencyKey',
      'recurring',
      'taxId',
    ]);
    const planId = uuid(d.planId),
      gateway = gatewayName(string(d.gateway, 'gateway'));
    if (!['MONTHLY', 'YEARLY'].includes(String(d.billingInterval)))
      throw new BadRequestException('Periodicidade inválida.');
    const billingInterval = d.billingInterval as 'MONTHLY' | 'YEARLY';
    boolean(d.recurring, 'recurring');
    const recurring = d.recurring === true;
    const rawKey = string(d.idempotencyKey, 'idempotencyKey', 128);
    const idempotencyKey = createHash('sha256')
      .update(`${companyId}:${rawKey}`)
      .digest('hex');
    const taxId =
      d.taxId === undefined ? undefined : string(d.taxId, 'taxId', 14);
    if (taxId && !/^\d{11}(\d{3})?$/.test(taxId))
      throw new BadRequestException('CPF/CNPJ inválido.');
    if (gateway === 'ASAAS' && !taxId)
      throw new BadRequestException('BILLING_TAX_ID_REQUIRED');
    const provider = this.registry.get(gateway),
      context = await this.gateways.context(gateway);
    if (
      recurring &&
      (!provider.createSubscription ||
        (gateway === 'PAGBANK' && !context.recurringEnabled))
    )
      throw new BadRequestException('GATEWAY_CAPABILITY_UNAVAILABLE');
    let payment = await this.prisma.payment.findUnique({
      where: { idempotencyKey },
    });
    if (!payment)
      payment = await this.prisma.$transaction(
        async (tx) => {
          if (context.configurationVersion) {
            const config = await tx.gatewayConfiguration.findUnique({
              where: { gateway },
            });
            if (
              !config?.enabled ||
              config.environment !== context.environment ||
              config.updatedAt.getTime() !==
                context.configurationVersion.getTime()
            )
              throw new ConflictException('GATEWAY_CONFIGURATION_CHANGED');
          }
          const existing = await tx.payment.findUnique({
            where: { idempotencyKey },
          });
          if (existing) return existing;
          const plan = await tx.plan.findFirst({
            where: {
              id: planId,
              isActive: true,
              ...(legacySubscriptionId ? {} : { isPublic: true }),
            },
          });
          if (!plan) throw new NotFoundException('Plano indisponível.');
          const amountCents =
            billingInterval === 'YEARLY'
              ? plan.yearlyPriceCents
              : plan.monthlyPriceCents;
          if (amountCents == null || amountCents <= 0)
            throw new BadRequestException('Preço não configurado.');
          const pending = await tx.payment.findFirst({
            where: {
              companyId,
              status: 'PENDING',
              creationState: {
                in: ['READY', 'CREATING', 'UNCERTAIN', 'CREATED'],
              },
            },
          });
          if (pending) throw new ConflictException('CHECKOUT_ALREADY_PENDING');
          const active = await tx.subscription.findFirst({
            where: {
              companyId,
              OR: [
                { status: 'ACTIVE', currentPeriodEnd: { gt: new Date() } },
                {
                  externalSubscriptionId: { not: null },
                  status: { not: 'CANCELED' },
                },
              ],
            },
          });
          if (active && !legacySubscriptionId)
            throw new ConflictException(
              'ACTIVE_SUBSCRIPTION_CANCEL_BEFORE_NEW_CHECKOUT',
            );
          const now = new Date();
          const sub = legacySubscriptionId
            ? await tx.subscription.findFirst({
                where: { id: legacySubscriptionId, companyId, planId },
              })
            : await tx.subscription.create({
                data: {
                  companyId,
                  planId,
                  billingInterval,
                  status: 'PENDING',
                  gateway,
                  environment: context.environment,
                  expectedAmountCents: amountCents,
                  currency: 'BRL',
                },
              });
          if (!sub || sub.status === 'CANCELED')
            throw new ConflictException('Assinatura indisponível.');
          const start =
            sub.currentPeriodEnd && sub.currentPeriodEnd > now
              ? sub.currentPeriodEnd
              : now;
          return tx.payment.create({
            data: {
              companyId,
              subscriptionId: sub.id,
              planId,
              billingInterval,
              amountCents,
              currency: 'BRL',
              gateway,
              environment: context.environment,
              idempotencyKey,
              recurring,
              status: 'PENDING',
              periodStart: start,
              periodEnd: nextPeriod(start, billingInterval),
            },
          });
        },
        { isolationLevel: 'Serializable' },
      );
    if (
      payment.companyId !== companyId ||
      payment.planId !== planId ||
      payment.gateway !== gateway ||
      payment.billingInterval !== billingInterval ||
      payment.recurring !== recurring ||
      payment.environment !== context.environment ||
      (legacySubscriptionId && payment.subscriptionId !== legacySubscriptionId)
    )
      throw new ConflictException('IDEMPOTENCY_SCOPE_MISMATCH');
    if (payment.creationState === 'CREATED') return this.view(payment);
    const owner = await this.prisma.membership.findFirst({
      where: {
        companyId,
        role: 'OWNER',
        isActive: true,
        user: { isActive: true },
      },
      select: { user: { select: { name: true, email: true } } },
    });
    if (!owner || !payment.subscriptionId || !payment.planId)
      throw new BadRequestException('BILLING_OWNER_REQUIRED');
    const claimed = await this.prisma.payment.updateMany({
      where: { id: payment.id, creationState: 'READY' },
      data: { creationState: 'CREATING', creationStartedAt: new Date() },
    });
    if (!claimed.count)
      throw new ConflictException('CHECKOUT_RECONCILIATION_REQUIRED');
    try {
      const chargeInput = {
        paymentId: payment.id,
        companyId,
        subscriptionId: payment.subscriptionId,
        planId: payment.planId,
        amountCents: payment.amountCents,
        currency: payment.currency,
        billingInterval,
        idempotencyKey: payment.id,
        name: `Kalend ${billingInterval}`,
        payerName: owner.user.name,
        email: owner.user.email,
        taxId,
        dueDate: payment.periodStart!.toISOString().slice(0, 10),
      };
      const charge = recurring
        ? await provider.createSubscription!(chargeInput, context)
        : await provider.createCharge(chargeInput, context);
      payment = await this.prisma.$transaction(async (tx) => {
        if (charge.externalSubscriptionId)
          await tx.subscription.update({
            where: { id: payment!.subscriptionId! },
            data: { externalSubscriptionId: charge.externalSubscriptionId },
          });
        return tx.payment.update({
          where: { id: payment!.id },
          data: {
            externalPaymentId: charge.externalPaymentId,
            externalCheckoutId: charge.externalCheckoutId,
            checkoutUrl: charge.checkoutUrl,
            creationState: 'CREATED',
          },
        });
      });
      return this.view(payment);
    } catch {
      // Never blindly repeat a possibly successful charge, including after a process crash.
      await this.prisma.payment.updateMany({
        where: { id: payment.id, creationState: 'CREATING' },
        data: { creationState: 'UNCERTAIN' },
      });
      throw new ServiceUnavailableException('CHECKOUT_RECONCILIATION_REQUIRED');
    }
  }
  view(p: Payment) {
    return {
      id: p.id,
      companyId: p.companyId,
      planId: p.planId,
      subscriptionId: p.subscriptionId,
      amountCents: p.amountCents,
      currency: p.currency,
      billingInterval: p.billingInterval,
      gateway: p.gateway,
      environment: p.environment,
      status: p.status,
      externalPaymentId: p.externalPaymentId,
      externalCheckoutId: p.externalCheckoutId,
      externalReference: p.id,
      checkoutUrl: p.checkoutUrl,
      creationState: p.creationState,
      recurring: p.recurring,
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      paidAt: p.paidAt,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      refundedAt: p.refundedAt,
      refundedAmountCents: p.refundedAmountCents,
      description: p.description,
      idempotencyKey: p.idempotencyKey,
    };
  }
}
