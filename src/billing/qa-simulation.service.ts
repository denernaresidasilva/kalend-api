import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { object, string, uuid } from '../common/validation.js';
import { qaRuntimeEnvironment } from '../communication/qa-policy.js';
import { nextPeriod } from '../common/period.js';
import { BillingDomain } from './billing-domain.js';

export const QA_TRANSITIONS = [
  'PAYMENT_PENDING',
  'PAYMENT_APPROVED',
  'PAYMENT_FAILED',
  'PAYMENT_OVERDUE',
  'SUBSCRIPTION_GRACE_PERIOD',
  'SUBSCRIPTION_SUSPENDED',
  'SUBSCRIPTION_REACTIVATED',
  'SUBSCRIPTION_CANCELLED',
] as const;
export function assertCommercialQa(
  companyId: string,
  superAdmin: boolean,
  env = process.env,
) {
  const ids = (env.QA_COMMUNICATION_COMPANY_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (
    qaRuntimeEnvironment(env) !== 'DEV' ||
    env.COMMERCIAL_QA_SIMULATION_ENABLED !== 'true' ||
    !superAdmin ||
    !ids.length ||
    ids.some(
      (id) =>
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          id,
        ),
    ) ||
    !ids.includes(companyId)
  )
    throw new ForbiddenException('COMMERCIAL_QA_SIMULATION_BLOCKED');
}

@Injectable()
export class QaSimulationService {
  constructor(@Inject(PrismaService) private readonly db: PrismaService) {}
  async simulate(input: unknown, actor: { id: string; isSuperAdmin: boolean }) {
    const d = object(input, [
      'companyId',
      'action',
      'paymentId',
      'planId',
      'billingInterval',
      'idempotencyKey',
    ]);
    const companyId = uuid(d.companyId);
    assertCommercialQa(companyId, actor.isSuperAdmin);
    const action = string(d.action, 'action');
    if (!QA_TRANSITIONS.includes(action as (typeof QA_TRANSITIONS)[number]))
      throw new BadRequestException('QA_TRANSITION_INVALID');
    if (!d.paymentId && action !== 'PAYMENT_PENDING')
      throw new BadRequestException('QA_PAYMENT_REQUIRED');
    const paymentId = d.paymentId === undefined ? undefined : uuid(d.paymentId);
    const planId = d.planId === undefined ? undefined : uuid(d.planId);
    const interval = d.billingInterval;
    if (
      !paymentId &&
      (!planId || !['MONTHLY', 'YEARLY'].includes(String(interval)))
    )
      throw new BadRequestException('QA_PLAN_REQUIRED');
    const key = !paymentId
      ? 'QA_SIMULATION:' +
        createHash('sha256')
          .update(
            `${companyId}:${string(d.idempotencyKey, 'idempotencyKey', 128)}`,
          )
          .digest('hex')
      : undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await this.db.$transaction(
          async (tx) => {
            // Rechecked inside the transaction, before any mutation.
            assertCommercialQa(companyId, actor.isSuperAdmin);
            const company = await tx.company.findFirst({
              where: {
                id: companyId,
                isActive: true,
                status: { in: ['ACTIVE', 'TRIAL'] },
              },
            });
            if (!company) throw new ForbiddenException('QA_COMPANY_NOT_ACTIVE');
            let payment = paymentId
              ? await tx.payment.findFirst({
                  where: {
                    id: paymentId,
                    companyId,
                    gateway: 'QA_SIMULATION',
                    environment: 'SANDBOX',
                  },
                  include: { subscription: true },
                })
              : await tx.payment.findUnique({
                  where: { idempotencyKey: key },
                  include: { subscription: true },
                });
            if (paymentId && !payment)
              throw new ForbiddenException('QA_PAYMENT_SCOPE_MISMATCH');
            if (!payment) {
              const plan = await tx.plan.findFirst({
                where: { id: planId, isActive: true },
              });
              if (!plan) throw new BadRequestException('QA_PLAN_UNAVAILABLE');
              const amountCents =
                interval === 'YEARLY'
                  ? plan.yearlyPriceCents
                  : plan.monthlyPriceCents;
              if (!amountCents || amountCents <= 0)
                throw new BadRequestException('QA_PLAN_PRICE_INVALID');
              // A separate QA subscription prevents mutation of existing real subscriptions.
              const subscription = await tx.subscription.create({
                data: {
                  companyId,
                  planId: plan.id,
                  status: 'PENDING',
                  gateway: 'QA_SIMULATION',
                  environment: 'SANDBOX',
                  billingInterval: interval as 'MONTHLY' | 'YEARLY',
                  expectedAmountCents: amountCents,
                },
              });
              const now = new Date();
              payment = await tx.payment.create({
                data: {
                  companyId,
                  subscriptionId: subscription.id,
                  planId: plan.id,
                  gateway: 'QA_SIMULATION',
                  environment: 'SANDBOX',
                  billingInterval: subscription.billingInterval,
                  amountCents,
                  currency: 'BRL',
                  status: 'PENDING',
                  creationState: 'CREATED',
                  idempotencyKey: key,
                  periodStart: now,
                  periodEnd: nextPeriod(now, subscription.billingInterval),
                  description: 'source=QA_SIMULATION',
                },
                include: { subscription: true },
              });
            }
            const sub = payment.subscription;
            if (
              payment.companyId !== companyId ||
              payment.gateway !== 'QA_SIMULATION' ||
              payment.environment !== 'SANDBOX' ||
              !sub ||
              sub.companyId !== companyId ||
              sub.planId !== payment.planId ||
              sub.gateway !== 'QA_SIMULATION' ||
              sub.environment !== 'SANDBOX' ||
              (planId && planId !== payment.planId) ||
              (interval && interval !== payment.billingInterval)
            )
              throw new ForbiddenException('QA_PAYMENT_SCOPE_MISMATCH');
            const eventId = `QA_SIMULATION:${payment.id}:${action}`;
            const existing = await tx.webhookEvent.findUnique({
              where: {
                gateway_environment_externalEventId: {
                  gateway: 'QA_SIMULATION',
                  environment: 'SANDBOX',
                  externalEventId: eventId,
                },
              },
            });
            if (existing)
              return {
                source: 'QA_SIMULATION',
                paymentId: payment.id,
                subscriptionId: sub.id,
                action,
                duplicate: true,
              };
            const domain = new BillingDomain();
            if (action.startsWith('PAYMENT_')) {
              const status = action.slice(8) as
                'PENDING' | 'APPROVED' | 'FAILED' | 'OVERDUE';
              if (
                sub.status === 'CANCELED' ||
                (payment.status === 'APPROVED' && status !== 'APPROVED')
              )
                throw new ConflictException('QA_TRANSITION_NOT_ALLOWED');
              await domain.payment(tx, 'QA_SIMULATION', {
                environment: 'SANDBOX',
                eventId,
                type: action,
                externalPaymentId: `QA_SIMULATION:${payment.id}`,
                externalReference: payment.id,
                companyId,
                planId: payment.planId!,
                status,
                amountCents: payment.amountCents,
                currency: payment.currency,
              });
            } else if (action === 'SUBSCRIPTION_REACTIVATED') {
              await domain.reactivate(tx, payment.id, companyId);
            } else {
              const status =
                action === 'SUBSCRIPTION_GRACE_PERIOD'
                  ? 'PAST_DUE'
                  : action === 'SUBSCRIPTION_SUSPENDED'
                    ? 'SUSPENDED'
                    : 'CANCELED';
              if (sub.status === 'CANCELED')
                throw new ConflictException('QA_TRANSITION_NOT_ALLOWED');
              if (status === 'PAST_DUE') {
                // Feed the same grace policy with a QA-only expired period.
                await domain.beginGrace(tx, sub.id, companyId);
              } else {
                await domain.subscription(tx, 'QA_SIMULATION', {
                  kind: 'subscription',
                  environment: 'SANDBOX',
                  eventId,
                  type: action,
                  externalReference: sub.id,
                  externalSubscriptionId: `QA_SIMULATION:${sub.id}`,
                  status,
                });
              }
            }
            // Existing DB triggers capture the durable facts. Mark their outbox entries
            // inside this SAME transaction: no parallel producer and no worker race.
            await tx.$executeRaw`
            UPDATE "GlobalCommunicationOutbox"
            SET "businessKey" = 'QA_SIMULATION:' || "businessKey"
            WHERE "companyId" = ${companyId}::uuid
              AND ("businessKey" LIKE ('PAYMENT_%:' || ${payment.id})
                OR "businessKey" LIKE ('SUBSCRIPTION_%:' || ${sub.id} || ':%'))
          `;
            await tx.webhookEvent.create({
              data: {
                gateway: 'QA_SIMULATION',
                environment: 'SANDBOX',
                externalEventId: eventId,
                eventType: action,
                companyId,
                paymentId: payment.id,
                status: 'PROCESSED',
                processedAt: new Date(),
                payload: { source: 'QA_SIMULATION', actorId: actor.id, action },
              },
            });
            return {
              source: 'QA_SIMULATION',
              paymentId: payment.id,
              subscriptionId: sub.id,
              action,
              duplicate: false,
            };
          },
          { isolationLevel: 'Serializable' },
        );
        new Logger('CommercialQaSimulation').log({
          actorId: actor.id,
          companyId,
          ...result,
        });
        return result;
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          ['P2002', 'P2034'].includes(error.code) &&
          attempt < 2
        )
          continue;
        throw error;
      }
    }
  }
}
