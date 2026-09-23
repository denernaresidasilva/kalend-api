import { Inject } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class SubscriptionsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async findAll() {
    const subscriptions = await this.prisma.subscription.findMany({
      orderBy: {
        createdAt: 'desc',
      },

      include: {
        company: true,

        plan: true,

        payments: {
          orderBy: {
            createdAt: 'desc',
          },
          take: 1,
        },
      },
    });

    return subscriptions.map((subscription) => {
      const lastPayment = subscription.payments[0] ?? null;

      return {
        id: subscription.id,

        status: subscription.status,

        trialStartsAt: subscription.trialStartedAt,

        trialEndsAt: subscription.trialEndsAt,

        currentPeriodStart: subscription.currentPeriodStart,

        currentPeriodEnd: subscription.currentPeriodEnd,

        canceledAt: subscription.canceledAt,

        createdAt: subscription.createdAt,

        updatedAt: subscription.updatedAt,

        company: {
          id: subscription.company.id,
          name: subscription.company.name,
          slug: subscription.company.slug,
          status: subscription.company.status,
        },

        plan: {
          id: subscription.plan.id,
          name: subscription.plan.name,
          code: subscription.plan.code,
          monthlyPriceCents: subscription.plan.monthlyPriceCents,
          yearlyPriceCents: subscription.plan.yearlyPriceCents,
        },

        lastPayment: lastPayment
          ? {
              id: lastPayment.id,
              status: lastPayment.status,
              amountCents: lastPayment.amountCents,
              createdAt: lastPayment.createdAt,
            }
          : null,
      };
    });
  }

  async findOne(id: string) {
    return this.prisma.subscription.findUnique({
      where: {
        id,
      },

      include: {
        company: true,

        plan: {
          include: {
            features: true,
          },
        },

        payments: {
          orderBy: {
            createdAt: 'desc',
          },
        },
      },
    });
  }
}
