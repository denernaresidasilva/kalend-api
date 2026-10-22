import { ServiceUnavailableException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
type AccessSubscription = { status: string; trialEndsAt?: Date | null };
export function effectiveAccessStatus(
  current: AccessSubscription | null,
  last: AccessSubscription | null,
  now: Date,
) {
  if (current?.status === 'TRIALING')
    return current.trialEndsAt &&
      current.trialEndsAt.getTime() - now.getTime() <= 3 * 86400000
      ? 'TRIAL_EXPIRING'
      : 'TRIAL_ACTIVE';
  if (current) return current.status;
  if (
    last?.trialEndsAt &&
    last.trialEndsAt <= now &&
    ['TRIALING', 'EXPIRED'].includes(last.status)
  )
    return 'TRIAL_EXPIRED';
  return last?.status === 'ACTIVE' || last?.status === 'PAST_DUE'
    ? 'SUSPENDED'
    : (last?.status ?? 'NO_SUBSCRIPTION');
}
export function graceEnd(from: Date, days?: number): Date {
  const value =
    days === undefined ? process.env.BILLING_GRACE_DAYS : String(days);
  // Unconfigured means no grace, never an invented positive allowance.
  if (value !== undefined && !/^(0|[1-9]\d{0,2})$/.test(value))
    throw new ServiceUnavailableException('BILLING_GRACE_DAYS_INVALID');
  return new Date(from.getTime() + Number(value ?? 0) * 86400000);
}
/** Preserve a paid deadline; without one, zero tolerance is no grace window. */
export function graceDeadline(
  periodEnd: Date | null,
  now: Date,
  days?: number,
): Date | null {
  if (!periodEnd) return null;
  const end = graceEnd(periodEnd, days);
  return end > periodEnd && end > now ? end : null;
}
export function entitledWhere(
  companyId: string,
  now = new Date(),
): Prisma.SubscriptionWhereInput {
  const evidence: Prisma.SubscriptionEntitlementWhereInput = {
    revokedAt: null,
    startsAt: { lte: now },
    OR: [
      { origin: 'ADMIN_GRANT' },
      {
        origin: 'PAYMENT',
        paymentEvidence: {
          some: {
            status: 'APPLIED',
            revokedAt: null,
            payment: { status: 'APPROVED', paidAt: { not: null } },
          },
        },
      },
    ],
  };
  return {
    companyId,
    company: { administrativeStatus: 'ACTIVE' },
    OR: [
      { status: 'TRIALING', trialEndsAt: { gt: now } },
      {
        status: { in: ['ACTIVE', 'PAST_DUE'] },
        entitlements: { some: { ...evidence, endsAt: { gt: now } } },
      },
      {
        status: 'PAST_DUE',
        graceEndsAt: { gt: now },
        entitlements: {
          some: { ...evidence, endsAt: { lte: now }, graceEndsAt: { gt: now } },
        },
      },
    ],
  };
}
export async function suspendIfUnentitled(
  tx: Prisma.TransactionClient,
  companyId: string,
  now: Date,
) {
  if (!(await tx.subscription.count({ where: entitledWhere(companyId, now) })))
    await tx.company.update({
      where: { id: companyId },
      data: { status: 'SUSPENDED', isActive: false },
    });
}

/** Grace extends one proven right, anchored to its immutable end; never to the request clock. */
export async function eligibleGrace(
  tx: Prisma.TransactionClient,
  sub: { id: string; currentPeriodEnd: Date | null },
  now: Date,
  days?: number,
) {
  if (!sub.currentPeriodEnd) return null;
  const right = await tx.subscriptionEntitlement.findFirst({
    where: {
      subscriptionId: sub.id,
      revokedAt: null,
      endsAt: sub.currentPeriodEnd,
      OR: [
        {
          origin: 'PAYMENT',
          paymentEvidence: {
            some: {
              status: 'APPLIED',
              revokedAt: null,
              payment: { status: 'APPROVED', paidAt: { not: null } },
            },
          },
        },
        { origin: 'ADMIN_GRANT', graceEndsAt: { not: null }, legacy: false },
      ],
    },
    orderBy: { endsAt: 'desc' },
  });
  if (!right) return null;
  const deadline =
    right.origin === 'ADMIN_GRANT'
      ? right.graceEndsAt
      : graceDeadline(right.endsAt, now, days);
  if (!deadline || deadline <= now) return null;
  // A persisted deadline can never be extended by retries or a changed runtime policy.
  if (right.graceEndsAt)
    return right.graceEndsAt > now ? right.graceEndsAt : null;
  await tx.subscriptionEntitlement.update({
    where: { id: right.id },
    data: { graceEndsAt: deadline },
  });
  return deadline;
}
