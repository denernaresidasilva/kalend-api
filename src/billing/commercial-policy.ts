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
export function graceEnd(from: Date): Date {
  const value = process.env.BILLING_GRACE_DAYS;
  // Unconfigured means no grace, never an invented positive allowance.
  if (value !== undefined && !/^(0|[1-9]\d{0,2})$/.test(value))
    throw new ServiceUnavailableException('BILLING_GRACE_DAYS_INVALID');
  return new Date(from.getTime() + Number(value ?? 0) * 86400000);
}
export function entitledWhere(
  companyId: string,
  now = new Date(),
): Prisma.SubscriptionWhereInput {
  return {
    companyId,
    OR: [
      { status: 'ACTIVE', currentPeriodEnd: { gt: now } },
      { status: 'TRIALING', trialEndsAt: { gt: now } },
      { status: 'PAST_DUE', graceEndsAt: { gt: now } },
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
