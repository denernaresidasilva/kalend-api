import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { recoverySubscription } from './recovery-policy.js';
import { qaRecoverableCompany } from './company-policy.js';
import { createHash } from 'node:crypto';
import { userInfo } from 'node:os';
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
export function assertCommercialQaScope(companyId: string, env = process.env) {
  const ids = (env.QA_COMMUNICATION_COMPANY_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (
    qaRuntimeEnvironment(env) !== 'DEV' ||
    env.COMMERCIAL_QA_SIMULATION_ENABLED !== 'true' ||
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
export function assertCommercialQa(
  companyId: string,
  superAdmin: boolean,
  env = process.env,
) {
  assertCommercialQaScope(companyId, env);
  if (superAdmin !== true)
    throw new ForbiddenException('COMMERCIAL_QA_SIMULATION_BLOCKED');
}
type QaActor =
  | { execution: 'HTTP'; id: string; isSuperAdmin: boolean }
  | { execution: 'CLI'; operator: string; operatorUid: number };

@Injectable()
export class QaSimulationService {
  constructor(@Inject(PrismaService) private readonly db: PrismaService) {}
  async simulate(input: unknown, actor: { id: string; isSuperAdmin: boolean }) {
    return this.apply(input, {
      execution: 'HTTP',
      id: actor.id,
      isSuperAdmin: actor.isSuperAdmin,
    });
  }
  /** Operational entry, authorized by DEV policy and access to the private host. No HTTP identity is forged. */
  async simulateFromCli(input: unknown) {
    const operator = userInfo();
    return this.apply(input, {
      execution: 'CLI',
      operator: operator.username,
      operatorUid: operator.uid,
    });
  }
  private async requireActiveCompany(
    tx: Prisma.TransactionClient,
    companyId: string,
    action = 'CHECK',
  ) {
    const company = await tx.company.findUnique({ where: { id: companyId } });
    if (!qaRecoverableCompany(company))
      throw new ForbiddenException('QA_COMPANY_NOT_ACTIVE');
    if (
      company!.status === 'SUSPENDED' &&
      ![
        'CHECK',
        'PAYMENT_PENDING',
        'PAYMENT_APPROVED',
        'SUBSCRIPTION_REACTIVATED',
      ].includes(action)
    )
      throw new ForbiddenException('QA_COMPANY_RECOVERY_ONLY');
    return company!;
  }
  /** Read-only operator preflight; never applies a transition, publishes an event or starts a worker. */
  async preflightFromCli(company: unknown) {
    const companyId = uuid(company);
    assertCommercialQaScope(companyId);
    return this.db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        assertCommercialQaScope(companyId);
        const company = await this.requireActiveCompany(tx, companyId);
        const values = await tx.$queryRaw<{ enumlabel: string }[]>`
        SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid
        WHERE t.typname='PaymentGateway' AND e.enumlabel='QA_SIMULATION'
      `;
        if (!values.length)
          throw new ConflictException('QA_SIMULATION_SCHEMA_NOT_AVAILABLE');
        return {
          source: 'QA_SIMULATION',
          execution: 'CLI',
          environment: 'DEV',
          companyId,
          flagEnabled: true,
          qaCompanyAuthorized: true,
          companyActive: company.isActive,
          companyStatus: company.status,
          administrativeStatus: company.administrativeStatus,
          recoveryOnly: company.status === 'SUSPENDED',
          enumAvailable: true,
          readOnly: true,
          safeToSimulate: true,
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
  private async apply(input: unknown, actor: QaActor) {
    const d = object(input, [
      'companyId',
      'action',
      'paymentId',
      'planId',
      'billingInterval',
      'idempotencyKey',
      'subscriptionId',
      'graceDays',
    ]);
    const companyId = uuid(d.companyId);
    const assertAccess = () => {
      if (actor.execution === 'HTTP')
        assertCommercialQa(companyId, actor.isSuperAdmin);
      else assertCommercialQaScope(companyId);
    };
    assertAccess();
    const audit =
      actor.execution === 'HTTP'
        ? { execution: 'HTTP', actorId: actor.id }
        : {
            execution: 'CLI',
            operator: actor.operator,
            operatorUid: actor.operatorUid,
          };
    const action = string(d.action, 'action');
    if (!QA_TRANSITIONS.includes(action as (typeof QA_TRANSITIONS)[number]))
      throw new BadRequestException('QA_TRANSITION_INVALID');
    if (!d.paymentId && action !== 'PAYMENT_PENDING')
      throw new BadRequestException('QA_PAYMENT_REQUIRED');
    const subscriptionId =
      d.subscriptionId === undefined ? undefined : uuid(d.subscriptionId);
    const graceDays = d.graceDays;
    if (
      graceDays !== undefined &&
      (!Number.isInteger(graceDays) ||
        Number(graceDays) < 0 ||
        Number(graceDays) > 999 ||
        ![
          'PAYMENT_OVERDUE',
          'PAYMENT_FAILED',
          'SUBSCRIPTION_GRACE_PERIOD',
        ].includes(action))
    )
      throw new BadRequestException('QA_GRACE_DAYS_INVALID');
    const paymentId = d.paymentId === undefined ? undefined : uuid(d.paymentId);
    const planId = d.planId === undefined ? undefined : uuid(d.planId);
    const interval = d.billingInterval;
    if (
      !paymentId &&
      !subscriptionId &&
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
            assertAccess();
            const company = await this.requireActiveCompany(
              tx,
              companyId,
              action,
            );
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
              const recovery = subscriptionId
                ? await tx.subscription.findFirst({
                    where: {
                      id: subscriptionId,
                      companyId,
                      status: { in: ['PAST_DUE', 'SUSPENDED'] },
                      gateway: 'QA_SIMULATION',
                      environment: 'SANDBOX',
                    },
                  })
                : null;
              if (subscriptionId && !recovery)
                throw new ForbiddenException('QA_SUBSCRIPTION_SCOPE_MISMATCH');
              if (company.status === 'SUSPENDED' && !recovery)
                throw new ForbiddenException(
                  'QA_RECOVERY_SUBSCRIPTION_REQUIRED',
                );
              if (
                recovery &&
                (await recoverySubscription(tx, companyId))?.id !== recovery.id
              )
                throw new ConflictException('QA_RECOVERY_ENTITLEMENT_CONFLICT');
              const plan = await tx.plan.findFirst({
                where: { id: recovery?.planId ?? planId, isActive: true },
              });
              if (!plan) throw new BadRequestException('QA_PLAN_UNAVAILABLE');
              const amountCents =
                (recovery?.billingInterval ?? interval) === 'YEARLY'
                  ? plan.yearlyPriceCents
                  : plan.monthlyPriceCents;
              if (!amountCents || amountCents <= 0)
                throw new BadRequestException('QA_PLAN_PRICE_INVALID');
              // A separate QA subscription prevents mutation of existing real subscriptions.
              const subscription =
                recovery ??
                (await tx.subscription.create({
                  data: {
                    companyId,
                    planId: plan.id,
                    status: 'PENDING',
                    gateway: 'QA_SIMULATION',
                    environment: 'SANDBOX',
                    billingInterval: interval as 'MONTHLY' | 'YEARLY',
                    expectedAmountCents: amountCents,
                  },
                }));
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
            if (subscriptionId && payment.subscriptionId !== subscriptionId)
              throw new ConflictException('QA_SUBSCRIPTION_SCOPE_MISMATCH');
            const sub = payment.subscription;
            if (
              company.status === 'SUSPENDED' &&
              (!sub || !['PAST_DUE', 'SUSPENDED'].includes(sub.status))
            )
              throw new ForbiddenException('QA_RECOVERY_SUBSCRIPTION_REQUIRED');
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
            const domain = new BillingDomain(
              graceDays === undefined
                ? undefined
                : { graceDays: Number(graceDays) },
            );
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
                payload: {
                  source: 'QA_SIMULATION',
                  ...audit,
                  action,
                  ...(graceDays === undefined ? {} : { graceDays }),
                },
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
          ...audit,
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
