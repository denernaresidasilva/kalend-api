import { ServiceUnavailableException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
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
