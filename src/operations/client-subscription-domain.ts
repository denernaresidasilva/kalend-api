import { localMinuteToUtc } from '../bookings/booking-domain.js';
import type { Prisma } from '@prisma/client';
import type { Operator } from './operations.service.js';
import { entitledWhere } from '../billing/commercial-policy.js';
import { netReceived, proportionFloor } from './pos-domain.js';
export function addCycleMonths(start: Date, months: number, timezone = 'UTC') {
  const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(start),
    part = (key: string) => Number(parts.find((p) => p.type === key)!.value);
  const target = new Date(
    Date.UTC(part('year'), part('month') - 1 + months, 1),
  );
  const max = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(part('day'), max));
  const date = target.toISOString().slice(0, 10),
    minute = part('hour') * 60 + part('minute');
  return new Date(
    localMinuteToUtc(date, minute, timezone).getTime() +
      start.getUTCSeconds() * 1000 +
      start.getUTCMilliseconds(),
  );
}

export async function prepareClientCycle(
  tx: Prisma.TransactionClient,
  actor: Operator,
  definition: { id: string; cycleMonths: number | null },
  customerId: string,
) {
  let subscription = await tx.posClientSubscription.findUnique({
    where: {
      companyId_customerId_definitionId: {
        companyId: actor.companyId,
        customerId,
        definitionId: definition.id,
      },
    },
  });
  const now = new Date();
  if (!subscription)
    subscription = await tx.posClientSubscription.create({
      data: {
        companyId: actor.companyId,
        customerId,
        definitionId: definition.id,
        nextRenewalAt: now,
      },
    });
  const startsAt =
      subscription.nextRenewalAt > now ? subscription.nextRenewalAt : now,
    endsAt = addCycleMonths(
      startsAt,
      definition.cycleMonths ?? 1,
      (
        await tx.company.findUniqueOrThrow({
          where: { id: actor.companyId },
          select: { timezone: true },
        })
      ).timezone,
    ),
    ordinal = subscription.fundedCycles + 1;
  return { subscription, startsAt, endsAt, ordinal };
}
export async function fundClientCycle(
  tx: Prisma.TransactionClient,
  actor: Operator,
  prepared: Awaited<ReturnType<typeof prepareClientCycle>>,
  walletId: string,
) {
  const { subscription, startsAt, endsAt, ordinal } = prepared;
  const cycle = await tx.posClientSubscriptionCycle.upsert({
    where: {
      subscriptionId_ordinal: { subscriptionId: subscription.id, ordinal },
    },
    create: {
      companyId: actor.companyId,
      subscriptionId: subscription.id,
      ordinal,
      startsAt,
      endsAt,
      status: 'PAID',
      sourceWalletId: walletId,
      paidAt: new Date(),
    },
    update: {
      startsAt,
      endsAt,
      status: 'PAID',
      sourceWalletId: walletId,
      paidAt: new Date(),
    },
  });
  const keepSuspended =
    subscription.status === 'SUSPENDED' &&
    subscription.suspensionReason === 'MANUAL';
  await tx.posClientSubscription.update({
    where: { id: subscription.id },
    data: {
      status: keepSuspended ? 'SUSPENDED' : 'ACTIVE',
      suspensionReason: keepSuspended ? 'MANUAL' : null,
      cancelledAt: null,
      nextRenewalAt: endsAt,
      fundedCycles: ordinal,
    },
  });
  await tx.posClientSubscriptionEvent.create({
    data: {
      companyId: actor.companyId,
      subscriptionId: subscription.id,
      sourceKey: 'FUND:' + walletId,
      type: 'MANUAL_RENEWAL_PAID',
      actorId: actor.userId,
      reason:
        'Ciclo liberado por comanda paga e finalizada. Sem cobrança externa automática.',
    },
  });
  return cycle;
}
export async function clientBenefits(
  tx: Prisma.TransactionClient,
  companyId: string,
  customerId: string | null,
  at = new Date(),
) {
  const none = {
    discountBps: 0,
    discountSubscriptionId: null as string | null,
    bonusPoints: 0,
    bonusCycleId: null as string | null,
  };
  if (!customerId) return none;
  const cycles = await tx.posClientSubscriptionCycle.findMany({
    where: {
      companyId,
      status: 'PAID',
      startsAt: { lte: at },
      endsAt: { gt: at },
      subscription: { customerId, status: { in: ['ACTIVE', 'CANCELLED'] } },
      sourceWallet: { status: 'ACTIVE', sourceSale: { status: 'PAID' } },
    },
    include: { subscription: { include: { definition: true } } },
    take: 500,
  });
  if (
    !cycles.length ||
    !(await tx.subscription.findFirst({
      where: {
        ...entitledWhere(companyId),
        plan: { features: { some: { code: 'packages', enabled: true } } },
      },
      select: { id: true },
    }))
  )
    return none;
  for (const c of cycles) {
    if (c.subscription.definition.discountBps > none.discountBps) {
      none.discountBps = c.subscription.definition.discountBps;
      none.discountSubscriptionId = c.subscriptionId;
    }
    if (c.subscription.definition.loyaltyBonusPoints > none.bonusPoints) {
      none.bonusPoints = c.subscription.definition.loyaltyBonusPoints;
      none.bonusCycleId = c.id;
    }
  }
  return none;
}
export async function subscriptionBonusRatio(
  tx: Prisma.TransactionClient,
  companyId: string,
  cycleId: string,
  points: number,
) {
  const cycle = await tx.posClientSubscriptionCycle.findFirst({
    where: { id: cycleId, companyId },
    include: {
      sourceWallet: {
        include: { sourceSale: { include: { payments: true, refunds: true } } },
      },
    },
  });
  const source = cycle?.sourceWallet?.sourceSale;
  if (!source || !source.totalCents) return 0;
  return proportionFloor(
    points,
    Math.max(
      0,
      Math.min(source.totalCents, netReceived(source.payments, source.refunds)),
    ),
    source.totalCents,
  );
}
