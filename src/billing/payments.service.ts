import { Inject } from '@nestjs/common';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { object, string, uuid } from '../common/validation.js';
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
  async create(input: unknown) {
    const data = object(input, [
      'companyId',
      'subscriptionId',
      'planId',
      'gateway',
      'idempotencyKey',
    ]);
    const companyId = uuid(data.companyId),
      subscriptionId = uuid(data.subscriptionId),
      planId = uuid(data.planId);
    const gateway = gatewayName(string(data.gateway, 'gateway'));
    const idempotencyKey = string(data.idempotencyKey, 'idempotencyKey', 128);
    const subscription = await this.prisma.subscription.findFirst({
      where: { id: subscriptionId, companyId, planId },
      include: { plan: true },
    });
    if (!subscription)
      throw new NotFoundException(
        'Assinatura não encontrada para empresa/plano.',
      );
    if (
      !subscription.plan.isActive ||
      ['CANCELED', 'EXPIRED'].includes(subscription.status)
    )
      throw new BadRequestException('Assinatura/plano indisponível.');
    const amountCents =
      subscription.billingInterval === 'YEARLY'
        ? subscription.plan.yearlyPriceCents
        : subscription.plan.monthlyPriceCents;
    if (amountCents === null || amountCents < 0)
      throw new BadRequestException('Preço não configurado.');
    let payment = await this.prisma.payment.findUnique({
      where: { idempotencyKey },
    });
    const assertScope = (p: {
      companyId: string;
      subscriptionId: string | null;
      planId: string | null;
      gateway: string;
    }) => {
      if (
        p.companyId !== companyId ||
        p.subscriptionId !== subscriptionId ||
        p.planId !== planId ||
        p.gateway !== gateway
      )
        throw new ConflictException('Chave de idempotência já utilizada.');
    };
    if (payment) {
      assertScope(payment);
      if (payment.externalPaymentId) return payment;
    }
    const provider = this.registry.get(gateway);
    const context = await this.gateways.context(gateway);
    if (!payment) {
      const start =
        subscription.currentPeriodEnd &&
        subscription.currentPeriodEnd > new Date()
          ? subscription.currentPeriodEnd
          : new Date();
      try {
        payment = await this.prisma.payment.create({
          data: {
            companyId,
            subscriptionId,
            planId,
            gateway,
            environment: context.environment,
            idempotencyKey,
            amountCents,
            currency: 'BRL',
            status: 'PENDING',
            periodStart: start,
            periodEnd: nextPeriod(start, subscription.billingInterval),
          },
        });
      } catch (error) {
        if (
          !(error instanceof Prisma.PrismaClientKnownRequestError) ||
          error.code !== 'P2002'
        )
          throw error;
        payment = await this.prisma.payment.findUniqueOrThrow({
          where: { idempotencyKey },
        });
        assertScope(payment);
      }
    }
    if (payment.environment !== context.environment)
      throw new ConflictException('PAYMENT_ENVIRONMENT_MISMATCH');
    // Retry the SAME provider idempotency key on timeout. Never fabricate an approval.
    const charge = await provider.createCharge(
      {
        paymentId: payment.id,
        companyId,
        subscriptionId,
        planId,
        amountCents: payment.amountCents,
        currency: payment.currency,
        idempotencyKey,
      },
      context,
    );
    return this.prisma.payment.update({
      where: { id: payment.id },
      data: { externalPaymentId: charge.externalPaymentId },
    });
  }
}
