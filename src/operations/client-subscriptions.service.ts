import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { OperationsService, type Operator } from './operations.service.js';
import { object, string, uuid } from '../common/validation.js';
import { addCycleMonths } from './client-subscription-domain.js';
import { queueCustomerEvent } from './operational-messages.js';
import { withBillingConflictRetry } from '../billing/transaction-conflict.js';
@Injectable()
export class ClientSubscriptionsService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(OperationsService) private readonly ops: OperationsService,
  ) {}
  async list(actor: Operator, own = false) {
    const customer = own
      ? await this.db.customerProfile.findFirst({
          where: { companyId: actor.companyId, userId: actor.userId },
        })
      : null;
    if (own && !customer) return [];
    return this.db.posClientSubscription.findMany({
      where: {
        companyId: actor.companyId,
        ...(own ? { customerId: customer!.id } : {}),
      },
      include: {
        company: { select: { timezone: true } },
        customer: { select: { name: true } },
        definition: {
          select: {
            name: true,
            cycleMonths: true,
            discountBps: true,
            loyaltyBonusPoints: true,
            product: { select: { priceCents: true } },
            terms: true,
          },
        },
        cycles: {
          select: {
            id: true,
            ordinal: true,
            startsAt: true,
            endsAt: true,
            status: true,
            paidAt: true,
            sourceWalletId: true,
          },
          orderBy: { ordinal: 'desc' },
          take: 24,
        },
        events: {
          select: { type: true, reason: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 50,
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }
  async change(actor: Operator, id: string, input: unknown) {
    const b = object(input, ['action', 'reason', 'idempotencyKey']),
      action = String(b.action),
      reason = string(b.reason, 'reason', 1000),
      key = uuid(b.idempotencyKey);
    if (!['SUSPEND', 'RESUME', 'CANCEL'].includes(action))
      throw new BadRequestException('Ação inválida.');
    const hash = createHash('sha256')
      .update(JSON.stringify({ id, action, reason }))
      .digest('hex');
    return this.ops.change(
      actor,
      action === 'CANCEL' ? ['OWNER', 'ADMIN', 'CLIENT'] : ['OWNER', 'ADMIN'],
      async (tx) => {
        if (
          actor.role === 'CLIENT' &&
          !(await tx.posClientSubscription.findFirst({
            where: {
              id,
              companyId: actor.companyId,
              customer: { userId: actor.userId },
            },
          }))
        )
          throw new NotFoundException();
        const previous = await tx.posClientSubscriptionEvent.findUnique({
          where: {
            companyId_sourceKey: { companyId: actor.companyId, sourceKey: key },
          },
        });
        if (previous) {
          if (previous.requestHash !== hash)
            throw new ConflictException('Chave já utilizada.');
          return previous;
        }
        const subscription = await tx.posClientSubscription.findFirst({
          where: { id, companyId: actor.companyId },
        });
        if (!subscription) throw new NotFoundException();
        if (
          action === 'RESUME' &&
          !(await tx.posClientSubscriptionCycle.findFirst({
            where: {
              companyId: actor.companyId,
              subscriptionId: id,
              status: 'PAID',
              startsAt: { lte: new Date() },
              endsAt: { gt: new Date() },
              sourceWallet: {
                status: 'ACTIVE',
                sourceSale: { status: 'PAID' },
              },
            },
          }))
        )
          throw new ConflictException(
            'Não existe período pago vigente para reativar.',
          );
        await tx.posClientSubscription.update({
          where: { id },
          data: {
            status:
              action === 'CANCEL'
                ? 'CANCELLED'
                : action === 'SUSPEND'
                  ? 'SUSPENDED'
                  : 'ACTIVE',
            suspensionReason: action === 'SUSPEND' ? 'MANUAL' : null,
            cancelledAt: action === 'CANCEL' ? new Date() : null,
          },
        });
        if (action === 'CANCEL')
          await tx.posClientSubscriptionCycle.updateMany({
            where: {
              companyId: actor.companyId,
              subscriptionId: id,
              status: 'DUE',
            },
            data: { status: 'CANCELLED' },
          });
        const event = await tx.posClientSubscriptionEvent.create({
          data: {
            companyId: actor.companyId,
            subscriptionId: id,
            type: action,
            reason,
            actorId: actor.userId,
            sourceKey: key,
            requestHash: hash,
          },
        });
        await this.ops.notify(tx, actor.companyId);
        return event;
      },
    );
  }
  async reconcile(companyIds?: string[]) {
    const rows = await this.db.posClientSubscription.findMany({
      where: {
        status: 'ACTIVE',
        nextRenewalAt: { lte: new Date() },
        ...(companyIds ? { companyId: { in: companyIds } } : {}),
      },
      include: { definition: true, company: { select: { timezone: true } } },
      orderBy: { nextRenewalAt: 'asc' },
      take: 100,
    });
    let due = 0;
    for (const row of rows) {
      const changed = await withBillingConflictRetry(() =>
        this.db.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${row.companyId + ':operations'},0))::text`;
            const current = await tx.posClientSubscription.findUniqueOrThrow({
              where: { id: row.id },
            });
            if (
              current.status !== 'ACTIVE' ||
              current.nextRenewalAt > new Date()
            )
              return false;
            const owner = await tx.membership.findFirst({
              where: {
                companyId: row.companyId,
                isActive: true,
                role: 'OWNER',
              },
            });
            if (!owner) return false;
            const ordinal = current.fundedCycles + 1;
            const cycle = await tx.posClientSubscriptionCycle.upsert({
              where: {
                subscriptionId_ordinal: { subscriptionId: row.id, ordinal },
              },
              create: {
                companyId: row.companyId,
                subscriptionId: row.id,
                ordinal,
                startsAt: current.nextRenewalAt,
                endsAt: addCycleMonths(
                  current.nextRenewalAt,
                  row.definition.cycleMonths ?? 1,
                  row.company.timezone,
                ),
              },
              update: {},
            });
            await tx.posClientSubscription.update({
              where: { id: row.id },
              data: { status: 'SUSPENDED', suspensionReason: 'OVERDUE' },
            });
            await tx.posClientSubscriptionEvent.upsert({
              where: {
                companyId_sourceKey: {
                  companyId: row.companyId,
                  sourceKey: 'DUE:' + cycle.id,
                },
              },
              create: {
                companyId: row.companyId,
                subscriptionId: row.id,
                sourceKey: 'DUE:' + cycle.id,
                type: 'MANUAL_RENEWAL_DUE',
                actorId: owner.userId,
                reason:
                  'Período pago terminou. Renovação manual; nenhuma cobrança criada.',
              },
              update: {},
            });
            await tx.notification.createMany({
              data: [
                {
                  companyId: row.companyId,
                  userId: owner.userId,
                  sourceKey: 'client-subscription-due:' + cycle.id,
                  type: 'CLIENT_SUBSCRIPTION_RENEWAL',
                  title: 'Clube aguardando renovação manual',
                  message:
                    'Um período terminou. Confira o cadastro e abra a renovação no PDV, se solicitada pelo cliente.',
                  actionUrl: '/painel/proprietario',
                  actionLabel: 'Ver clubes',
                },
              ],
              skipDuplicates: true,
            });
            await queueCustomerEvent(
              tx,
              row.companyId,
              row.customerId,
              'OP_CLIENT_SUBSCRIPTION_DUE',
              cycle.id,
              { __clientCycleId: cycle.id, servico: row.definition.name },
            );
            return true;
          },
          { isolationLevel: 'Serializable', timeout: 10000 },
        ),
      );
      if (changed) due++;
    }
    return { checked: rows.length, due, externalCharges: 0 };
  }
}
