import { ConflictException } from '@nestjs/common';
import type { Prisma, Subscription } from '@prisma/client';
import type {
  Gateway,
  SubscriptionEvent,
  VerifiedEvent,
} from './gateway.types.js';
import { integer } from '../common/validation.js';
import { nextPeriod } from '../common/period.js';
import { graceEnd, suspendIfUnentitled } from './commercial-policy.js';
export type BillingOrigin = Gateway | 'QA_SIMULATION';
/** Shared verified commercial transitions. No provider or transport dependencies. */
export class BillingDomain {
  async activatePaid(
    tx: Prisma.TransactionClient,
    p: Prisma.PaymentGetPayload<{ include: { subscription: true } }>,
    now = new Date(),
  ) {
    const sub = p.subscription;
    if (!sub || sub.status === 'CANCELED')
      throw new ConflictException('SUBSCRIPTION_UNAVAILABLE');
    if (!p.periodStart || !p.periodEnd)
      throw new ConflictException('PAYMENT_PERIOD_MISSING');
    if (
      (!sub.currentPeriodEnd || p.periodEnd >= sub.currentPeriodEnd) &&
      p.periodEnd > now
    ) {
      // Competing checkouts cannot silently overwrite an already paid plan.
      const newer = await tx.subscription.findFirst({
        where: {
          companyId: p.companyId,
          id: { not: sub.id },
          status: 'ACTIVE',
          currentPeriodEnd: { gt: now },
          createdAt: { gt: sub.createdAt },
        },
        select: { id: true },
      });
      if (!newer) {
        // QA changes only its bound subscription; real provider behavior is preserved.
        if (p.gateway !== 'QA_SIMULATION')
          await tx.subscription.updateMany({
            where: {
              companyId: p.companyId,
              id: { not: sub.id },
              status: 'TRIALING',
            },
            data: { status: 'EXPIRED', endedAt: now },
          });
        await tx.subscription.update({
          where: { id: sub.id },
          data: {
            status: 'ACTIVE',
            gateway: p.gateway,
            environment: p.environment,
            currentPeriodStart: p.periodStart,
            currentPeriodEnd: p.periodEnd,
            graceEndsAt: null,
            endedAt: null,
          },
        });
        await tx.company.update({
          where: { id: p.companyId },
          data: { status: 'ACTIVE', isActive: true },
        });
        return true;
      }
    }
    return false;
  }
  async elapsed(tx: Prisma.TransactionClient, sub: Subscription, now: Date) {
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
  async beginGrace(
    tx: Prisma.TransactionClient,
    subscriptionId: string,
    companyId: string,
  ) {
    const sub = await tx.subscription.findFirst({
      where: { id: subscriptionId, companyId },
    });
    if (!sub || !['ACTIVE', 'PAST_DUE'].includes(sub.status))
      throw new ConflictException('SUBSCRIPTION_GRACE_NOT_ALLOWED');
    const now = new Date();
    const end = graceEnd(now);
    if (end <= now) throw new ConflictException('BILLING_GRACE_NOT_CONFIGURED');
    await tx.subscription.update({
      where: { id: sub.id },
      data: { currentPeriodEnd: now, graceEndsAt: null },
    });
    await this.elapsed(
      tx,
      { ...sub, status: 'ACTIVE', currentPeriodEnd: now },
      now,
    );
  }
  async reactivate(
    tx: Prisma.TransactionClient,
    paymentId: string,
    companyId: string,
  ) {
    const p = await tx.payment.findFirst({
      where: { id: paymentId, companyId },
      include: { subscription: true },
    });
    const now = new Date();
    if (
      !p?.subscription ||
      p.status !== 'APPROVED' ||
      !p.periodEnd ||
      p.periodEnd <= now ||
      !['PAST_DUE', 'SUSPENDED'].includes(p.subscription.status)
    )
      throw new ConflictException('PAID_REACTIVATION_REQUIRED');
    if (!(await this.activatePaid(tx, p, now)))
      throw new ConflictException('PAID_REACTIVATION_NOT_APPLIED');
  }
  async subscription(
    tx: Prisma.TransactionClient,
    gateway: BillingOrigin,
    e: SubscriptionEvent,
  ) {
    let sub = await tx.subscription.findUnique({
      where: {
        gateway_environment_externalSubscriptionId: {
          gateway,
          environment: e.environment,
          externalSubscriptionId: e.externalSubscriptionId,
        },
      },
    });
    if (!sub && e.externalReference)
      sub = await tx.subscription.findFirst({
        where: { id: e.externalReference, gateway, environment: e.environment },
      });
    if (!sub && e.externalReference) {
      const intent = await tx.payment.findFirst({
        where: {
          id: e.externalReference,
          gateway,
          environment: e.environment,
          recurring: true,
        },
        include: { subscription: true },
      });
      sub = intent?.subscription ?? null;
    }
    if (
      !sub ||
      (sub.externalSubscriptionId &&
        sub.externalSubscriptionId !== e.externalSubscriptionId)
    )
      throw new ConflictException('SUBSCRIPTION_REFERENCE_MISMATCH');
    const now = new Date();
    await tx.subscription.update({
      where: { id: sub.id },
      data: {
        externalSubscriptionId: e.externalSubscriptionId,
        ...(e.status === 'CANCELED'
          ? { status: 'CANCELED', canceledAt: now, endedAt: now }
          : e.status === 'SUSPENDED'
            ? { status: 'SUSPENDED' }
            : e.status === 'PAST_DUE' && sub.status !== 'CANCELED'
              ? {
                  status: 'PAST_DUE',
                  graceEndsAt:
                    sub.graceEndsAt ?? graceEnd(sub.currentPeriodEnd ?? now),
                }
              : {}),
        cancelAtPeriodEnd: e.cancelAtPeriodEnd,
      },
    });
    // Subscription ACTIVE means mandate enabled; only a verified payment grants paid entitlement.
    if (['CANCELED', 'SUSPENDED', 'PAST_DUE'].includes(e.status))
      await suspendIfUnentitled(tx, sub.companyId, now);
    return { companyId: sub.companyId };
  }
  async payment(
    tx: Prisma.TransactionClient,
    gateway: BillingOrigin,
    e: VerifiedEvent,
  ) {
    const externalWhere = {
      gateway_environment_externalPaymentId: {
        gateway,
        environment: e.environment,
        externalPaymentId: e.externalPaymentId,
      },
    };
    let p = await tx.payment.findUnique({
      where: externalWhere,
      include: { subscription: true },
    });
    if (!p && e.externalReference)
      p = await tx.payment.findFirst({
        where: {
          id: e.externalReference,
          gateway,
          environment: e.environment,
          OR: [
            { externalPaymentId: null },
            { externalPaymentId: e.externalPaymentId },
          ],
        },
        include: { subscription: true },
      });
    if (!p && e.externalSubscriptionId) {
      const sub = await tx.subscription.findUnique({
        where: {
          gateway_environment_externalSubscriptionId: {
            gateway,
            environment: e.environment,
            externalSubscriptionId: e.externalSubscriptionId,
          },
        },
      });
      if (sub && sub.expectedAmountCents !== null) {
        // First charge binds to the pending intent; later invoices receive distinct immutable periods.
        p = await tx.payment.findFirst({
          where: { subscriptionId: sub.id, externalPaymentId: null },
          include: { subscription: true },
          orderBy: { createdAt: 'asc' },
        });
        if (!p) {
          if (e.cycle !== undefined) {
            integer(e.cycle, 'cycle', 1, 1200);
            const first = await tx.payment.findFirst({
              where: { subscriptionId: sub.id },
              orderBy: { createdAt: 'asc' },
            });
            if (!first?.periodStart)
              throw new ConflictException('RENEWAL_PERIOD_REQUIRED');
            let start = first.periodStart;
            for (let n = 1; n < e.cycle; n++)
              start = nextPeriod(start, sub.billingInterval);
            e = {
              ...e,
              periodStart: start.toISOString(),
              periodEnd: nextPeriod(start, sub.billingInterval).toISOString(),
            };
          }
          if (!e.periodStart)
            throw new ConflictException('RENEWAL_PERIOD_REQUIRED');
          const start = new Date(e.periodStart),
            end = e.periodEnd
              ? new Date(e.periodEnd)
              : nextPeriod(start, sub.billingInterval);
          if (
            !Number.isFinite(start.getTime()) ||
            !Number.isFinite(end.getTime()) ||
            end <= start
          )
            throw new ConflictException('RENEWAL_PERIOD_INVALID');
          p = await tx.payment.create({
            data: {
              companyId: sub.companyId,
              subscriptionId: sub.id,
              planId: sub.planId,
              billingInterval: sub.billingInterval,
              gateway,
              environment: e.environment,
              amountCents: sub.expectedAmountCents,
              currency: sub.currency,
              externalPaymentId: e.externalPaymentId,
              status: 'PENDING',
              creationState: 'CREATED',
              recurring: true,
              periodStart: start,
              periodEnd: end,
            },
            include: { subscription: true },
          });
        }
      }
    }
    if (
      !p ||
      !p.subscription ||
      p.gateway !== gateway ||
      p.environment !== e.environment ||
      (p.subscription.environment !== null &&
        p.subscription.environment !== undefined &&
        p.subscription.environment !== e.environment) ||
      p.subscription.companyId !== p.companyId ||
      p.subscription.planId !== p.planId ||
      p.amountCents !== e.amountCents ||
      p.currency !== e.currency ||
      (e.companyId && e.companyId !== p.companyId) ||
      (e.planId && e.planId !== p.planId) ||
      (p.externalPaymentId && p.externalPaymentId !== e.externalPaymentId) ||
      (e.externalSubscriptionId &&
        p.subscription.externalSubscriptionId &&
        e.externalSubscriptionId !== p.subscription.externalSubscriptionId)
    )
      throw new ConflictException('PAYMENT_REFERENCE_MISMATCH');
    const sub = p.subscription,
      now = new Date();
    if (
      gateway === 'PAGBANK' &&
      p.recurring &&
      e.externalPaymentId.startsWith('CHAR_')
    )
      return { paymentId: p.id, companyId: p.companyId }; // recurring invoices are the canonical financial resource
    if (e.externalSubscriptionId && !sub.externalSubscriptionId)
      await tx.subscription.update({
        where: { id: sub.id },
        data: { externalSubscriptionId: e.externalSubscriptionId },
      });
    const referenceAllowed =
      !e.externalReference ||
      e.externalReference === p.id ||
      e.externalReference === sub.id ||
      (p.recurring && e.externalSubscriptionId === sub.externalSubscriptionId);
    if (!referenceAllowed)
      throw new ConflictException('PAYMENT_REFERENCE_MISMATCH');
    const refund =
      e.status === 'REFUNDED'
        ? (e.refundIsDelta ? p.refundedAmountCents : 0) +
          (e.refundedAmountCents ?? e.amountCents)
        : p.refundedAmountCents;
    if (refund > p.amountCents)
      throw new ConflictException('REFUND_AMOUNT_MISMATCH');
    const allowed =
      !['APPROVED', 'REFUNDED'].includes(p.status) ||
      (e.status === 'REFUNDED' && refund > p.refundedAmountCents);
    if (allowed) {
      const fullRefund = e.status === 'REFUNDED' && refund === p.amountCents;
      const status =
        e.status === 'REFUNDED' && !fullRefund ? 'APPROVED' : e.status;
      await tx.payment.update({
        where: { id: p.id },
        data: {
          externalPaymentId: e.externalPaymentId,
          creationState: 'CREATED',
          status,
          refundedAmountCents: refund,
          paidAt: e.status === 'APPROVED' ? (p.paidAt ?? now) : undefined,
          refundedAt: e.status === 'REFUNDED' ? now : undefined,
        },
      });
      if (e.status === 'APPROVED' && sub.status !== 'CANCELED')
        await this.activatePaid(tx, p, now);
      if (
        sub.status !== 'CANCELED' &&
        ((fullRefund &&
          p.periodEnd?.getTime() === sub.currentPeriodEnd?.getTime()) ||
          (['FAILED', 'OVERDUE'].includes(e.status) &&
            (!sub.currentPeriodEnd || sub.currentPeriodEnd <= now)))
      ) {
        await tx.subscription.update({
          where: { id: sub.id },
          data: {
            status: fullRefund ? 'SUSPENDED' : 'PAST_DUE',
            graceEndsAt: fullRefund
              ? null
              : (sub.graceEndsAt ?? graceEnd(sub.currentPeriodEnd ?? now)),
          },
        });
        await suspendIfUnentitled(tx, p.companyId, now);
      }
    }
    return { paymentId: p.id, companyId: p.companyId };
  }
}
