import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { GatewayRegistry, gatewayName } from './gateway.provider.js';
import { GatewaysService } from './gateways.service.js';
import { WebhookProcessor } from './webhook-processor.service.js';
import { graceEnd, suspendIfUnentitled } from './commercial-policy.js';
@Injectable()
export class LifecycleService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(GatewayRegistry) private readonly registry: GatewayRegistry,
    @Inject(GatewaysService) private readonly gateways: GatewaysService,
    @Inject(WebhookProcessor) private readonly processor: WebhookProcessor,
  ) {}
  async reconcile() {
    let checked = 0,
      failed = 0;
    // Bounded sweep with oldest checked first; updatedAt rotates records without dropping failures.
    const payments = await this.prisma.payment.findMany({
      where: {
        gateway: { not: 'MANUAL' },
        environment: { not: null },
        OR: [
          { status: { in: ['PENDING', 'OVERDUE', 'FAILED'] } },
          { recurring: true, subscription: { status: { not: 'CANCELED' } } },
        ],
      },
      include: { subscription: true },
      orderBy: { updatedAt: 'asc' },
      take: 100,
    });
    for (const p of payments) {
      try {
        const gateway = gatewayName(p.gateway),
          context = await this.gateways.context(gateway, false);
        if (context.environment !== p.environment) {
          throw new Error('GATEWAY_ENVIRONMENT_MISMATCH');
        }
        const events = await this.registry.get(gateway).reconcile(
          {
            paymentId: p.id,
            externalPaymentId: p.recurring ? null : p.externalPaymentId,
            externalCheckoutId: p.externalCheckoutId,
            externalSubscriptionId: p.subscription?.externalSubscriptionId,
          },
          context,
        );
        for (const event of events)
          await this.processor.processVerified(gateway, event);
        checked++;
      } catch {
        failed++;
      }
      await this.prisma.payment.update({
        where: { id: p.id },
        data: { updatedAt: new Date() },
      });
    }
    const now = new Date();
    const result = await this.prisma.$transaction(
      async (tx) => {
        const elapsed = await tx.subscription.findMany({
          where: {
            OR: [
              { status: 'TRIALING', trialEndsAt: { lte: now } },
              { status: 'ACTIVE', currentPeriodEnd: { lte: now } },
              {
                status: 'PAST_DUE',
                OR: [{ graceEndsAt: { lte: now } }, { graceEndsAt: null }],
              },
            ],
          },
        });
        for (const sub of elapsed) {
          const grace =
            sub.status === 'ACTIVE'
              ? graceEnd(sub.currentPeriodEnd!)
              : sub.graceEndsAt;
          const status =
            sub.status === 'TRIALING'
              ? 'EXPIRED'
              : sub.cancelAtPeriodEnd
                ? 'CANCELED'
                : grace && grace > now
                  ? 'PAST_DUE'
                  : 'SUSPENDED';
          await tx.subscription.update({
            where: { id: sub.id },
            data: {
              status,
              graceEndsAt: grace,
              endedAt: status === 'PAST_DUE' ? undefined : now,
            },
          });
          await suspendIfUnentitled(tx, sub.companyId, now);
        }
        return { expired: elapsed.length, reconciledAt: now };
      },
      { isolationLevel: 'Serializable' },
    );
    return {
      ...result,
      paymentsChecked: checked,
      paymentsFailed: failed,
      batchLimit: 100,
    };
  }
}
