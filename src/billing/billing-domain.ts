import { administrativelyActive } from './company-policy.js';
import { ConflictException } from '@nestjs/common';
import type { Prisma, Subscription } from '@prisma/client';
import type {
  Gateway,
  SubscriptionEvent,
  VerifiedEvent,
} from './gateway.types.js';
import { integer } from '../common/validation.js';
import { nextPeriod } from '../common/period.js';
import { eligibleGrace, entitledWhere, suspendIfUnentitled } from './commercial-policy.js';
export type BillingOrigin = Gateway | 'QA_SIMULATION';
/** Shared verified commercial transitions. No provider or transport dependencies. */
export class BillingDomain {
  constructor(private readonly policy?: { graceDays: number }) {}
  private async lockSubscription(tx: Prisma.TransactionClient, id: string) {
    // Serialize every entitlement mutation for a contract, even when different
    // payment webhooks arrive concurrently.
    if (typeof tx.$queryRaw === 'function')
      await tx.$queryRaw`SELECT id FROM "Subscription" WHERE id = ${id} FOR UPDATE`;
  }
  private onContractSchedule(
    sub: Subscription,
    start: Date,
    end: Date,
  ) {
    // A verified payment may cover an interval that overlaps a previously
    // paid interval (provider corrections, proration, or duplicate collection).
    // Validate the contracted duration, then union intervals for access; never
    // require every legitimate payment to share one fixed calendar anchor.
    return nextPeriod(start, sub.billingInterval).getTime() === end.getTime();
  }
  async activatePaid(
    tx: Prisma.TransactionClient,
    p: Prisma.PaymentGetPayload<{ include: { subscription: true } }>,
    now = new Date(),
  ) {
    const company = await tx.company.findUnique({ where: { id: p.companyId } });
    if (!administrativelyActive(company)) return false;
    const sub = p.subscription;
    if (!sub || sub.status === 'CANCELED')
      throw new ConflictException('SUBSCRIPTION_UNAVAILABLE');
    await this.lockSubscription(tx, sub.id);
    const locked = await tx.subscription.findUnique({ where: { id: sub.id } });
    if (!locked || locked.status === 'CANCELED')
      throw new ConflictException('SUBSCRIPTION_UNAVAILABLE');
    if (!p.periodStart || !p.periodEnd) {
      await tx.paymentEvidence.upsert({
        where: { paymentId: p.id },
        create: {
          paymentId: p.id, companyId: p.companyId, subscriptionId: sub.id,
          startsAt: p.periodStart, endsAt: p.periodEnd, status: 'REVIEW',
          reviewReason: 'PAYMENT_PERIOD_MISSING',
        },
        update: {},
      });
      return false;
    }
    const contractPeriod = this.onContractSchedule(
      locked, p.periodStart, p.periodEnd,
    );
    if (!contractPeriod) {
      await tx.paymentEvidence.upsert({
        where: { paymentId: p.id },
        create: {
          paymentId: p.id, companyId: p.companyId, subscriptionId: sub.id,
          startsAt: p.periodStart, endsAt: p.periodEnd, status: 'REVIEW',
          reviewReason: 'CONTRACT_PERIOD_REVIEW_REQUIRED',
        },
        update: {},
      });
      return false;
    }
    const existingRight = await tx.subscriptionEntitlement.findFirst({
      where: {
        subscriptionId: sub.id, origin: 'PAYMENT',
        startsAt: p.periodStart, endsAt: p.periodEnd,
      },
      select: { id: true },
    });
    const right = existingRight ?? await tx.subscriptionEntitlement.create({
      data: {
        subscriptionId: sub.id, origin: 'PAYMENT',
        startsAt: p.periodStart, endsAt: p.periodEnd,
      },
      select: { id: true },
    });
    const overlappingEvidence = await tx.paymentEvidence.findFirst({
      where: {
        subscriptionId: sub.id,
        paymentId: { not: p.id },
        status: 'APPLIED', revokedAt: null,
        startsAt: { lt: p.periodEnd },
        endsAt: { gt: p.periodStart },
        payment: { status: 'APPROVED', paidAt: { not: null } },
      },
      select: { id: true },
    });
    const priorEvidence = await tx.paymentEvidence.findUnique({
      where: { paymentId: p.id },
      select: { financialReviewRequired: true, reviewReason: true },
    });
    const financialReviewRequired = Boolean(
      overlappingEvidence ||
      (priorEvidence?.financialReviewRequired &&
        priorEvidence.reviewReason === 'PARTIAL_REFUND_REVIEW_REQUIRED'),
    );
    await tx.paymentEvidence.upsert({
      where: { paymentId: p.id },
      create: {
        paymentId: p.id, companyId: p.companyId, subscriptionId: sub.id,
        entitlementId: right.id, startsAt: p.periodStart, endsAt: p.periodEnd,
        status: 'APPLIED',
        financialReviewRequired,
        reviewReason: overlappingEvidence
          ? 'POSSIBLE_DUPLICATE_CHARGE'
          : priorEvidence?.reviewReason === 'PARTIAL_REFUND_REVIEW_REQUIRED'
            ? priorEvidence.reviewReason
            : null,
      },
      update: {
        entitlementId: right.id,
        startsAt: p.periodStart,
        endsAt: p.periodEnd,
        status: 'APPLIED',
        revokedAt: null,
        financialReviewRequired,
        reviewReason: overlappingEvidence
          ? 'POSSIBLE_DUPLICATE_CHARGE'
          : priorEvidence?.reviewReason === 'PARTIAL_REFUND_REVIEW_REQUIRED'
            ? priorEvidence.reviewReason
            : null,
      },
    });
    if (
      (!locked.currentPeriodEnd || p.periodEnd >= locked.currentPeriodEnd) &&
      p.periodEnd > now
    ) {
      // Competing checkouts cannot silently overwrite an already paid plan.
      const newer = await tx.subscription.findFirst({
        where: {
          ...entitledWhere(p.companyId, now),
          id: { not: sub.id },
          status: 'ACTIVE',
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
            currentPeriodStart: locked.currentPeriodStart ?? p.periodStart,
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
    // The deadline is persisted. A caller/sweep must not advance it early.
    if (
      (sub.status === 'TRIALING' && (!sub.trialEndsAt || sub.trialEndsAt > now)) ||
      (sub.status === 'ACTIVE' && sub.currentPeriodEnd && sub.currentPeriodEnd > now) ||
      (sub.status === 'PAST_DUE' &&
        ((sub.currentPeriodEnd && sub.currentPeriodEnd > now) ||
          (sub.graceEndsAt && sub.graceEndsAt > now)))
    ) return;
    const grace =
      sub.status === 'ACTIVE'
        ? await eligibleGrace(tx, sub, now, this.policy?.graceDays)
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
    if (!sub.currentPeriodEnd || sub.currentPeriodEnd > now)
      throw new ConflictException('SUBSCRIPTION_GRACE_NOT_DUE');
    const end = await eligibleGrace(tx, sub, now, this.policy?.graceDays);
    if (!end) throw new ConflictException('SUBSCRIPTION_GRACE_NOT_ALLOWED');
    await tx.subscription.update({
      where: { id: sub.id }, data: { status: 'PAST_DUE', graceEndsAt: end },
    });
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
            : e.status === 'PAST_DUE' && !['CANCELED', 'SUSPENDED'].includes(sub.status)
              ? {
                  status: 'PAST_DUE',
                  graceEndsAt:
                    await eligibleGrace(tx, sub, now, this.policy?.graceDays),
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
    await this.lockSubscription(tx, sub.id);
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
      (e.status === 'REFUNDED' && refund > p.refundedAmountCents) ||
      (p.status === 'APPROVED' && e.status === 'FAILED' &&
        e.type.toUpperCase().includes('CHARGEBACK'));
    if (allowed) {
      const fullRefund = e.status === 'REFUNDED' && refund === p.amountCents;
      const chargeback = e.status === 'FAILED' && e.type.toUpperCase().includes('CHARGEBACK');
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
      if (fullRefund || chargeback)
        await tx.paymentEvidence.updateMany({
          where: { paymentId: p.id, status: 'APPLIED', revokedAt: null },
          data: {
            status: 'REVOKED', revokedAt: now,
            reviewReason: chargeback ? 'PAYMENT_CHARGEBACK' : 'PAYMENT_REVERSED',
          },
        });
      else if (e.status === 'REFUNDED' && refund > p.refundedAmountCents)
        await tx.paymentEvidence.updateMany({
          where: { paymentId: p.id, status: 'APPLIED', revokedAt: null },
          data: {
            financialReviewRequired: true,
            reviewReason: 'PARTIAL_REFUND_REVIEW_REQUIRED',
          },
        });
      if (e.status === 'APPROVED' && sub.status !== 'CANCELED')
        await this.activatePaid(tx, p, now);
      if (
        sub.status !== 'CANCELED' &&
        (((fullRefund || chargeback) && p.periodEnd?.getTime() === sub.currentPeriodEnd?.getTime() &&
          !(await tx.subscription.count({
            where: { ...entitledWhere(p.companyId, now), id: sub.id },
          }))) ||
          (['FAILED', 'OVERDUE'].includes(e.status) && sub.status !== 'SUSPENDED' &&
            (!sub.currentPeriodEnd || sub.currentPeriodEnd <= now)))
      ) {
        await tx.subscription.update({
          where: { id: sub.id },
          data: {
            status: fullRefund || chargeback ? 'SUSPENDED' : 'PAST_DUE',
            graceEndsAt: fullRefund || chargeback
              ? null
              : (await eligibleGrace(tx, sub, now, this.policy?.graceDays)),
          },
        });
        await suspendIfUnentitled(tx, p.companyId, now);
      }
    }
    return { paymentId: p.id, companyId: p.companyId };
  }
}
