import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { entitledWhere } from './commercial-policy.js';

/** Shared authoritative target selection. Browser IDs never choose an arbitrary subscription. */
export async function recoverySubscription(
  tx: Pick<Prisma.TransactionClient, 'subscription'>,
  companyId: string,
) {
  if (
    await tx.subscription.findFirst({
      where: {
        ...entitledWhere(companyId),
        status: { in: ['ACTIVE', 'TRIALING'] },
      },
    })
  )
    return null;
  return tx.subscription.findFirst({
    where: { companyId, status: { in: ['PAST_DUE', 'SUSPENDED'] } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
}
export function assertRecoveryTerms(
  sub: {
    planId: string;
    billingInterval: string;
    gateway: string;
    environment: string | null;
  },
  terms: {
    planId: string;
    billingInterval: string;
    gateway: string;
    environment: string;
  },
) {
  if (
    sub.planId !== terms.planId ||
    sub.billingInterval !== terms.billingInterval ||
    sub.gateway !== terms.gateway ||
    sub.environment !== terms.environment
  )
    throw new ConflictException('RECOVERY_SUBSCRIPTION_TERMS_MISMATCH');
}
