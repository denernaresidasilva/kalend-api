import { adminList, listStatus } from '../common/admin-list.js';
import { Inject } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class SubscriptionsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async findAll(query: unknown = {}) {
    const page = adminList(query, ['status']);
    const subscriptions = await this.prisma.subscription.findMany({
      take: page.take,
      skip: page.skip,
      where: {
        status: listStatus(page.status, [
          'PENDING',
          'SUSPENDED',
          'TRIALING',
          'ACTIVE',
          'PAST_DUE',
          'CANCELED',
          'EXPIRED',
        ]),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],

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
