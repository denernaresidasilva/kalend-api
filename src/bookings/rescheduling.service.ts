import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  OperationsService,
  type Operator,
} from '../operations/operations.service.js';
import { object, string, uuid } from '../common/validation.js';
import {
  assertAvailability,
  assertItemsDoNotOverlap,
  assertNoOverlap,
  parseInstant,
} from './booking-domain.js';
import { attendanceEvent } from './attendance-domain.js';
@Injectable()
export class ReschedulingService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(OperationsService) private readonly ops: OperationsService,
  ) {}
  async move(actor: Operator, requestId: string, input: unknown) {
    const b = object(input, ['idempotencyKey', 'reason', 'items']),
      key = uuid(b.idempotencyKey),
      reason = string(b.reason, 'reason', 1000);
    if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > 8)
      throw new BadRequestException('Informe todos os itens.');
    const items = b.items.map((raw) => {
      const i = object(raw, ['itemId', 'professionalId', 'startsAt']);
      return {
        itemId: uuid(i.itemId),
        professionalId: uuid(i.professionalId),
        startsAt: parseInstant(i.startsAt),
      };
    });
    if (new Set(items.map((i) => i.itemId)).size !== items.length)
      throw new BadRequestException('Itens duplicados.');
    const hash = createHash('sha256')
      .update(JSON.stringify({ requestId, reason, items }))
      .digest('hex');
    return this.ops.change(
      actor,
      ['OWNER', 'ADMIN', 'RECEPTIONIST'],
      async (tx) => {
        const previous = await tx.bookingScheduleChange.findUnique({
          where: {
            companyId_idempotencyKey: {
              companyId: actor.companyId,
              idempotencyKey: key,
            },
          },
        });
        if (previous) {
          if (previous.requestHash !== hash)
            throw new ConflictException('Chave já utilizada.');
          return { id: requestId, status: 'CONFIRMED', changeId: previous.id };
        }
        const request = await tx.bookingRequest.findFirst({
          where: {
            id: requestId,
            companyId: actor.companyId,
            status: 'CONFIRMED',
          },
          include: { items: true, company: { select: { timezone: true } } },
        });
        if (!request) throw new NotFoundException();
        if (
          items.length !== request.items.length ||
          items.some((i) => !request.items.some((l) => l.id === i.itemId))
        )
          throw new BadRequestException(
            'Informe exatamente os itens deste agendamento.',
          );
        if (
          await tx.posSale.findFirst({
            where: {
              companyId: actor.companyId,
              bookingRequestId: requestId,
              status: { not: 'CANCELLED' },
            },
          })
        )
          throw new ConflictException(
            'Encerre a comanda no PDV antes de reagendar.',
          );
        const locks = [
          ...new Set([
            ...request.items.map(
              (i) => actor.companyId + ':professional:' + i.professionalId,
            ),
            ...items.map(
              (i) => actor.companyId + ':professional:' + i.professionalId,
            ),
            actor.companyId + ':customer:' + request.customerId,
          ]),
        ].sort();
        for (const l of locks)
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${l},0))::text`;
        const intervals = [];
        for (const item of items) {
          const original = request.items.find((l) => l.id === item.itemId)!;
          if (item.startsAt <= new Date())
            throw new ConflictException('Escolha horários futuros.');
          const pro = await tx.professionalProfile.findFirst({
            where: {
              id: item.professionalId,
              companyId: actor.companyId,
              active: true,
              membership: {
                isActive: true,
                role: { in: ['OWNER', 'ADMIN', 'PROFESSIONAL'] },
              },
              services: { some: { serviceId: original.serviceId } },
            },
            include: { availability: { where: { active: true } } },
          });
          if (!pro)
            throw new BadRequestException('Profissional não habilitado.');
          assertAvailability(
            item.startsAt,
            original.durationMinutes,
            request.company.timezone,
            pro.availability,
          );
          const endsAt = new Date(
            item.startsAt.getTime() + original.durationMinutes * 60000,
          );
          const conflicts = await tx.bookingRequestItem.findMany({
            where: {
              companyId: actor.companyId,
              requestId: { not: requestId },
              startsAt: { lt: endsAt },
              endsAt: { gt: item.startsAt },
              request: {
                OR: [
                  { status: 'CONFIRMED' },
                  { status: 'REQUESTED', holdExpiresAt: { gt: new Date() } },
                ],
              },
              OR: [
                { professionalId: item.professionalId },
                { request: { customerId: request.customerId } },
              ],
            },
            select: { startsAt: true, endsAt: true },
          });
          assertNoOverlap(item.startsAt, endsAt, conflicts);
          intervals.push({ ...item, endsAt });
        }
        assertItemsDoNotOverlap(intervals);
        const existing = await tx.bookingConfirmation.findUnique({
          where: {
            requestId_companyId: { requestId, companyId: actor.companyId },
          },
        });
        if (existing) {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${actor.companyId + ':confirmation:' + existing.id},0))::text`;
          await tx.bookingConfirmationInvitation.updateMany({
            where: {
              companyId: actor.companyId,
              confirmationId: existing.id,
              expiresAt: { gt: new Date() },
            },
            data: { expiresAt: new Date() },
          });
          await tx.bookingConfirmation.update({
            where: { id: existing.id },
            data: {
              revision: { increment: 1 },
              response: null,
              responseAt: null,
              deadlineResult: null,
              startsAt: intervals.reduce(
                (d, i) => (i.startsAt < d ? i.startsAt : d),
                intervals[0].startsAt,
              ),
              deadlineAt: intervals.reduce(
                (d, i) => (i.startsAt < d ? i.startsAt : d),
                intervals[0].startsAt,
              ),
            },
          });
        }
        for (const i of intervals)
          await tx.bookingRequestItem.update({
            where: { id: i.itemId },
            data: {
              professionalId: i.professionalId,
              startsAt: i.startsAt,
              endsAt: i.endsAt,
            },
          });
        const change = await tx.bookingScheduleChange.create({
          data: {
            companyId: actor.companyId,
            requestId,
            idempotencyKey: key,
            requestHash: hash,
            actorId: actor.userId,
            reason,
            before: request.items.map((i) => ({
              itemId: i.id,
              professionalId: i.professionalId,
              startsAt: i.startsAt.toISOString(),
            })),
            after: intervals.map((i) => ({
              itemId: i.itemId,
              professionalId: i.professionalId,
              startsAt: i.startsAt.toISOString(),
            })),
          },
        });
        await attendanceEvent(
          tx,
          actor.companyId,
          requestId,
          'RESCHEDULED',
          'MOVE:' + change.id,
          actor.userId,
          reason,
        );
        await this.ops.notify(tx, actor.companyId, [
          ...new Set([
            ...request.items.map((i) => i.professionalId),
            ...items.map((i) => i.professionalId),
          ]),
        ]);
        return { id: requestId, status: 'CONFIRMED', changeId: change.id };
      },
    );
  }
}
