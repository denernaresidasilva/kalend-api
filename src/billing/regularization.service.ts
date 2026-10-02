import type { MembershipRole } from '@prisma/client';
import type {
  CommercialTrial,
  CommercialFinancial,
  CommercialContext,
} from './regularization.types.js';
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
  withoutCompany(systemRole: 'SUPER_ADMIN' | 'USER') {
    return {
      serverNow: new Date().toISOString(),
      context: {
        systemRole,
        role: null,
        commercialApplicable: false,
      } satisfies CommercialContext,
      companyId: null,
      accessAllowed: false,
      status: 'NOT_APPLICABLE',
      reason: null,
      trialExpired: false,
      trial: {
        active: false,
        endsAt: null,
        expired: false,
        remainingDays: 0,
      } satisfies CommercialTrial,
      financial: {
        requiresAction: false,
        status: null,
        paymentStatus: null,
      } satisfies CommercialFinancial,
      subscription: null,
      plans: [],
      gateways: [],
      pendingCheckout: null,
    };
  }
  async get(companyId: string, role: MembershipRole = 'OWNER') {
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
    const trialActive =
      last?.status === 'TRIALING' &&
      !!last.trialEndsAt &&
      last.trialEndsAt > now;
    const managesBilling = ['OWNER', 'ADMIN'].includes(role);
    const latestPayment = last
      ? await this.prisma.payment.findFirst({
          where: { companyId, subscriptionId: last.id },
          select: { status: true },
          orderBy: { createdAt: 'desc' },
        })
      : null;
    const available = (managesBilling ? await this.gateways.list() : []).filter(
      (g) => g.enabled && g.status === 'CONNECTED',
    );
    const pending = managesBilling
      ? await this.prisma.payment.findFirst({
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
        })
      : null;
    return {
      serverNow: now.toISOString(),
      context: {
        systemRole: 'USER',
        role,
        commercialApplicable: true,
      } satisfies CommercialContext,
      trial: {
        active: trialActive,
        endsAt: last?.trialEndsAt ?? null,
        expired: trialExpired,
        remainingDays: trialActive
          ? Math.ceil((last!.trialEndsAt!.getTime() - now.getTime()) / 86400000)
          : 0,
      } satisfies CommercialTrial,
      financial: {
        requiresAction: !current && !trialExpired,
        status: last?.status ?? null,
        paymentStatus: latestPayment?.status ?? null,
      } satisfies CommercialFinancial,
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
      plans: managesBilling ? await this.plans.findPublic() : [],
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
