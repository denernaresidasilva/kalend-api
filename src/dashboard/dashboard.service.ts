import { Inject } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { safeEventSelect } from '../common/validation.js';
@Injectable()
export class DashboardService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}
  async summary() {
    const now = new Date();
    const monthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    return this.prisma.$transaction(
      async (tx) => {
        const [
          companies,
          users,
          subscriptions,
          payments,
          recentEvents,
          newCompanies,
          monthly,
        ] = await Promise.all([
          tx.company.groupBy({
            by: ['status', 'isActive'],
            _count: { _all: true },
          }),
          tx.user.count(),
          tx.subscription.groupBy({ by: ['status'], _count: { _all: true } }),
          tx.payment.groupBy({
            by: ['status'],
            _count: { _all: true },
            _sum: { amountCents: true },
          }),
          tx.webhookEvent.findMany({
            select: safeEventSelect,
            orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
            take: 10,
          }),
          tx.company.count({
            where: { createdAt: { gte: monthStart, lte: now } },
          }),
          tx.payment.aggregate({
            where: {
              status: 'APPROVED',
              paidAt: { gte: monthStart, lte: now },
            },
            _sum: { amountCents: true },
          }),
        ]);
        const companyCount = (status?: string) =>
          companies
            .filter((c) => !status || c.status === status)
            .reduce((sum, c) => sum + c._count._all, 0);
        const subscriptionCount = (status: string) =>
          subscriptions.find((s) => s.status === status)?._count._all ?? 0;
        const paymentCount = (status: string) =>
          payments.find((p) => p.status === status)?._count._all ?? 0;
        return {
          generatedAt: now,
          period: { from: monthStart, to: now, timezone: 'UTC' },
          companies: {
            total: companyCount(),
            active: companyCount('ACTIVE'),
            trial: companyCount('TRIAL'),
            suspended: companyCount('SUSPENDED'),
            canceled: companyCount('CANCELED'),
            inactive: companies
              .filter((c) => !c.isActive)
              .reduce((sum, c) => sum + c._count._all, 0),
            new: newCompanies,
          },
          users: { total: users },
          subscriptions: {
            total: subscriptions.reduce((sum, s) => sum + s._count._all, 0),
            active: subscriptionCount('ACTIVE'),
            trialing: subscriptionCount('TRIALING'),
            pastDue: subscriptionCount('PAST_DUE'),
            canceled: subscriptionCount('CANCELED'),
            expired: subscriptionCount('EXPIRED'),
          },
          payments: {
            total: payments.reduce((sum, p) => sum + p._count._all, 0),
            approved: paymentCount('APPROVED'),
            pending: paymentCount('PENDING'),
            failed: paymentCount('FAILED'),
            canceled: paymentCount('CANCELED'),
            refunded: paymentCount('REFUNDED'),
            revenueCents:
              payments.find((p) => p.status === 'APPROVED')?._sum.amountCents ??
              0,
            monthlyRevenueCents: monthly._sum.amountCents ?? 0,
          },
          recentEvents,
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
}
