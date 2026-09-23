import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class FinanceService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    const payments = await this.prisma.payment.findMany({
      orderBy: {
        createdAt: 'desc',
      },

      include: {
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

      company: payment.subscription?.company
        ? {
            id: payment.subscription.company.id,
            name: payment.subscription.company.name,
            slug: payment.subscription.company.slug,
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
    const payments = await this.prisma.payment.findMany({
      select: {
        status: true,
        amountCents: true,
        paidAt: true,
        createdAt: true,
      },
    });

    const now = new Date();

    const monthStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      1,
    );

    const approvedPayments = payments.filter(
      (payment) =>
        payment.status === 'APPROVED',
    );

    const revenueCents = approvedPayments.reduce(
      (total, payment) =>
        total + payment.amountCents,
      0,
    );

    const monthlyRevenueCents =
      approvedPayments
        .filter((payment) => {
          const date =
            payment.paidAt ?? payment.createdAt;

          return date >= monthStart;
        })
        .reduce(
          (total, payment) =>
            total + payment.amountCents,
          0,
        );

    const pendingCount = payments.filter(
      (payment) =>
        payment.status === 'PENDING',
    ).length;

    const failedCount = payments.filter(
      (payment) =>
        payment.status === 'FAILED' ||
        payment.status === 'CANCELED',
    ).length;

    return {
      revenueCents,
      monthlyRevenueCents,
      paymentsCount: payments.length,
      approvedCount: approvedPayments.length,
      pendingCount,
      failedCount,
    };
  }
}

