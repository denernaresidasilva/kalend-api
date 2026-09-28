import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { object, boolean } from '../common/validation.js';
import { PlansService } from '../plans/plans.service.js';
import { GatewaysService } from './gateways.service.js';
import { GatewayRegistry, gatewayName } from './gateway.provider.js';
import { entitledWhere, suspendIfUnentitled } from './commercial-policy.js';
@Injectable()
export class RegularizationService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PlansService) private readonly plans: PlansService,
    @Inject(GatewaysService) private readonly gateways: GatewaysService,
    @Inject(GatewayRegistry) private readonly registry: GatewayRegistry,
  ) {}
  async get(companyId: string) {
    const now = new Date();
    const current = await this.prisma.subscription.findFirst({
      where: entitledWhere(companyId, now),
      include: { plan: true },
      orderBy: { createdAt: 'desc' },
    });
    const last =
      current ??
      (await this.prisma.subscription.findFirst({
        where: { companyId, status: { not: 'PENDING' } },
        include: { plan: true },
        orderBy: { createdAt: 'desc' },
      }));
    const trialExpired =
      !!last?.trialEndsAt &&
      last.trialEndsAt <= now &&
      ['TRIALING', 'EXPIRED'].includes(last.status);
    const available = (await this.gateways.list()).filter(
      (g) => g.enabled && g.status === 'CONNECTED',
    );
    const pending = await this.prisma.payment.findFirst({
      where: { companyId, status: 'PENDING' },
      select: {
        id: true,
        planId: true,
        gateway: true,
        billingInterval: true,
        checkoutUrl: true,
        creationState: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    return {
      companyId,
      accessAllowed: !!current,
      status: trialExpired
        ? 'TRIAL_EXPIRED'
        : (last?.status ?? 'NO_SUBSCRIPTION'),
      reason: current
        ? null
        : trialExpired
          ? 'TRIAL_EXPIRED'
          : 'PAYMENT_REQUIRED',
      trialExpired,
      subscription: last
        ? {
            id: last.id,
            status: last.status,
            planId: last.planId,
            planName: last.plan.name,
            billingInterval: last.billingInterval,
            trialStartedAt: last.trialStartedAt,
            trialEndsAt: last.trialEndsAt,
            currentPeriodEnd: last.currentPeriodEnd,
            graceEndsAt: last.graceEndsAt,
            cancelAtPeriodEnd: last.cancelAtPeriodEnd,
          }
        : null,
      plans: await this.plans.findPublic(),
      gateways: available.map((g) => ({
        provider: g.gateway,
        environment: g.environment,
        capabilities: g.capabilities,
      })),
      pendingCheckout: pending,
    };
  }
  async cancel(companyId: string, subscriptionId: string, input: unknown) {
    const d = object(input, ['atPeriodEnd']);
    boolean(d.atPeriodEnd, 'atPeriodEnd');
    const atPeriodEnd = d.atPeriodEnd === true;
    const sub = await this.prisma.subscription.findFirst({
      where: { id: subscriptionId, companyId },
    });
    if (!sub) throw new NotFoundException('Assinatura não encontrada.');
    if (sub.status === 'CANCELED') return { id: sub.id, status: sub.status };
    if (
      atPeriodEnd &&
      (!sub.currentPeriodEnd || sub.currentPeriodEnd <= new Date())
    )
      throw new BadRequestException('SUBSCRIPTION_HAS_NO_CURRENT_PERIOD');
    if (sub.externalSubscriptionId) {
      const gateway = gatewayName(sub.gateway),
        provider = this.registry.get(gateway),
        context = await this.gateways.context(gateway, false);
      if (context.environment !== sub.environment)
        throw new BadRequestException('GATEWAY_ENVIRONMENT_MISMATCH');
      if (
        !provider.cancelSubscription ||
        (atPeriodEnd && !provider.capabilities.cancelAtPeriodEnd)
      )
        throw new BadRequestException('GATEWAY_CAPABILITY_UNAVAILABLE');
      await this.prisma.subscription.update({
        where: { id: sub.id },
        data: { cancellationRequestedAt: new Date() },
      });
      await provider.cancelSubscription(
        sub.externalSubscriptionId,
        context,
        atPeriodEnd,
      );
    }
    return this.prisma.$transaction(
      async (tx) => {
        const now = new Date();
        const updated = await tx.subscription.update({
          where: { id: sub.id },
          data: {
            cancellationRequestedAt: now,
            cancelAtPeriodEnd: atPeriodEnd,
            ...(atPeriodEnd
              ? {}
              : { status: 'CANCELED', canceledAt: now, endedAt: now }),
          },
          select: {
            id: true,
            status: true,
            cancelAtPeriodEnd: true,
            currentPeriodEnd: true,
          },
        });
        if (!atPeriodEnd) await suspendIfUnentitled(tx, companyId, now);
        return updated;
      },
      { isolationLevel: 'Serializable' },
    );
  }
}
