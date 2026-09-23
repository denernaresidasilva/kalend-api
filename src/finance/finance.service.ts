import { Inject } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class FinanceService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async findAll() {
    const payments = await this.prisma.payment.findMany({
      orderBy: {
        createdAt: 'desc',
      },

      include: {
        company: true,
        subscription: {
          include: {
            company: true,
            plan: true,
          },
        },
      },
    });

    return payments.map((payment) => ({
      id: payment.id,
      status: payment.status,
      amountCents: payment.amountCents,
      gateway: payment.gateway,
      externalPaymentId: payment.externalPaymentId,
      paidAt: payment.paidAt,
      createdAt: payment.createdAt,
      updatedAt: payment.updatedAt,

      company: payment.company
        ? {
            id: payment.company.id,
            name: payment.company.name,
            slug: payment.company.slug,
          }
        : null,

      plan: payment.subscription?.plan
        ? {
            id: payment.subscription.plan.id,
            name: payment.subscription.plan.name,
            code: payment.subscription.plan.code,
          }
        : null,

      subscription: payment.subscription
        ? {
            id: payment.subscription.id,
            status: payment.subscription.status,
          }
        : null,
    }));
  }

  async summary() {
    const now = new Date();
    const monthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    return this.prisma.$transaction(
      async (tx) => {
        const [groups, monthly] = await Promise.all([
          tx.payment.groupBy({
            by: ['status'],
            _count: { _all: true },
            _sum: { amountCents: true },
          }),
          tx.payment.aggregate({
            where: {
              status: 'APPROVED',
              paidAt: { gte: monthStart, lte: now },
            },
            _sum: { amountCents: true },
          }),
        ]);
        const count = (status: string) =>
          groups.find((p) => p.status === status)?._count._all ?? 0;
        return {
          revenueCents:
            groups.find((p) => p.status === 'APPROVED')?._sum.amountCents ?? 0,
          monthlyRevenueCents: monthly._sum.amountCents ?? 0,
          paymentsCount: groups.reduce((sum, p) => sum + p._count._all, 0),
          approvedCount: count('APPROVED'),
          pendingCount: count('PENDING'),
          failedCount: count('FAILED'),
          canceledCount: count('CANCELED'),
          refundedCount: count('REFUNDED'),
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
}
