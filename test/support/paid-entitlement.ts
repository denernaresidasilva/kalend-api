import type { PrismaClient, Subscription } from '@prisma/client';
/** Persist real financial evidence for historical paid fixtures; never a mock authorization result. */
export async function paidEvidence(
  db: PrismaClient,
  sub: Subscription,
  graceDays = 0,
) {
  if (
    !sub.currentPeriodStart ||
    !sub.currentPeriodEnd ||
    sub.currentPeriodEnd <= sub.currentPeriodStart
  )
    throw Error('TEST_PAID_PERIOD_REQUIRED');
  const p = await db.payment.create({
    data: {
      companyId: sub.companyId,
      subscriptionId: sub.id,
      planId: sub.planId,
      gateway: sub.gateway,
      environment: sub.environment,
      billingInterval: sub.billingInterval,
      currency: sub.currency,
      amountCents: 199,
      status: 'APPROVED',
      paidAt: sub.currentPeriodStart,
      periodStart: sub.currentPeriodStart,
      periodEnd: sub.currentPeriodEnd,
    },
  });
  const right = await db.subscriptionEntitlement.create({
    data: {
      subscriptionId: sub.id,
      origin: 'PAYMENT',
      startsAt: p.periodStart!,
      endsAt: p.periodEnd!,
    },
  });
  await db.paymentEvidence.create({
    data: {
      paymentId: p.id,
      companyId: sub.companyId,
      subscriptionId: sub.id,
      entitlementId: right.id,
      startsAt: p.periodStart!,
      endsAt: p.periodEnd!,
    },
  });
  if (graceDays)
    await db.subscriptionEntitlement.update({
      where: { id: right.id },
      data: {
        graceEndsAt: new Date(p.periodEnd!.getTime() + graceDays * 86400000),
      },
    });
  return p;
}
