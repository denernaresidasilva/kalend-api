import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuthConfig } from '../auth/auth.config.js';
import { integer, object, string, uuid } from '../common/validation.js';
import {
  OperationsService,
  type Operator,
} from '../operations/operations.service.js';
import { queueCustomerEvent } from '../operations/operational-messages.js';
import { EntitlementsService } from '../billing/entitlements.service.js';
import { withBillingConflictRetry } from '../billing/transaction-conflict.js';
import { cancelBookingInTx } from './booking-cancellation.js';
import { attendanceEvent } from './attendance-domain.js';
export function confirmationToken(input: unknown) {
  if (typeof input !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input))
    throw new NotFoundException('Link inválido ou expirado.');
  return createHash('sha256').update(input).digest('hex');
}
@Injectable()
export class ConfirmationsService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(OperationsService) private readonly ops: OperationsService,
    @Inject(EntitlementsService)
    private readonly entitlements: EntitlementsService,
  ) {}
  async settings(actor: Operator, input?: unknown) {
    if (input === undefined)
      return {
        settings: await this.db.bookingConfirmationSettings.findUnique({
          where: { companyId: actor.companyId },
        }),
      };
    const b = object(input, [
      'enabled',
      'leadMinutes',
      'responseMinutes',
      'reminderMinutes',
      'channels',
      'noResponseRule',
    ]);
    if (
      typeof b.enabled !== 'boolean' ||
      !['NONE', 'NOTIFY_STAFF', 'CANCEL'].includes(String(b.noResponseRule))
    )
      throw new BadRequestException('Regra inválida.');
    integer(b.leadMinutes, 'leadMinutes', 5, 10080);
    integer(b.responseMinutes, 'responseMinutes', 5, 10080);
    if (
      !Array.isArray(b.channels) ||
      b.channels.length < 1 ||
      b.channels.length > 3 ||
      b.channels.some((c) => !['EMAIL', 'WHATSAPP', 'PUSH'].includes(String(c)))
    )
      throw new BadRequestException('Canais inválidos.');
    if (!Array.isArray(b.reminderMinutes) || b.reminderMinutes.length > 3)
      throw new BadRequestException('Configure até três lembretes.');
    for (const n of b.reminderMinutes)
      integer(n, 'reminderMinutes', 1, Number(b.leadMinutes) - 1);
    return this.ops.change(actor, ['OWNER', 'ADMIN'], async (tx) => {
      const data = {
        enabled: b.enabled as boolean,
        leadMinutes: b.leadMinutes as number,
        responseMinutes: b.responseMinutes as number,
        reminderMinutes: [...new Set(b.reminderMinutes as number[])].sort(
          (a, b) => b - a,
        ),
        channels: [...new Set(b.channels as string[])],
        noResponseRule: b.noResponseRule as string,
      };
      const row = await tx.bookingConfirmationSettings.upsert({
        where: { companyId: actor.companyId },
        create: { companyId: actor.companyId, ...data },
        update: data,
      });
      await tx.posAudit.create({
        data: {
          companyId: actor.companyId,
          actorId: actor.userId,
          action: 'CONFIRMATION_SETTINGS_SAVED',
          detail: data,
        },
      });
      return row;
    });
  }
  async view(input: unknown) {
    const b = object(input, ['token']),
      tokenHash = confirmationToken(b.token);
    const invite = await this.db.bookingConfirmationInvitation.findFirst({
      where: {
        tokenHash,
        expiresAt: { gt: new Date() },
        confirmation: {
          request: {
            status: 'CONFIRMED',
            company: { isActive: true, administrativeStatus: 'ACTIVE' },
          },
        },
      },
      include: {
        confirmation: {
          include: {
            request: {
              include: {
                company:{select:{timezone:true}},
                customer: {
                  select: {
                    userId: true,
                    user: { select: { isActive: true } },
                  },
                },
                items: {
                  select: {
                    serviceName: true,
                    startsAt: true,
                    professional: { select: { displayName: true } },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (
      !invite ||
      !invite.confirmation.request.customer.user?.isActive ||
      !(await this.db.membership.findFirst({
        where: {
          companyId: invite.companyId,
          userId: invite.confirmation.request.customer.userId ?? '',
          isActive: true,
        },
      }))
    )
      throw new NotFoundException('Link inválido ou expirado.');
    await this.entitlements.current(invite.companyId);
    return {
      expiresAt: invite.expiresAt,
      response: invite.confirmation.response,
      used: Boolean(invite.usedAt),
      items: invite.confirmation.request.items,timezone:invite.confirmation.request.company.timezone,
    };
  }
  async respond(input: unknown) {
    const b = object(input, ['token', 'action']),
      tokenHash = confirmationToken(b.token),
      action = String(b.action);
    if (!['CONFIRM', 'RESCHEDULE', 'CANCEL'].includes(action))
      throw new BadRequestException('Ação inválida.');
    return withBillingConflictRetry(() =>
      this.db.$transaction(
        async (tx) => {
          const seed = await tx.bookingConfirmationInvitation.findUnique({
            where: { tokenHash },
          });
          if (!seed) throw new NotFoundException('Link inválido ou expirado.');
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${seed.companyId + ':confirmation:' + seed.confirmationId},0))::text`;
          const invite =
            await tx.bookingConfirmationInvitation.findUniqueOrThrow({
              where: { tokenHash },
              include: {
                confirmation: {
                  include: {
                    request: {
                      include: {
                        customer: {
                          include: { user: { select: { isActive: true } } },
                        },
                        company: { select: { slug: true } },
                      },
                    },
                  },
                },
              },
            });
          if (invite.expiresAt <= new Date())
            throw new NotFoundException('Link inválido ou expirado.');
          await this.entitlements.current(invite.companyId, tx);
          const c = invite.confirmation,
            request = c.request;
          if (
            !request.customer.user?.isActive ||
            !(await tx.membership.findFirst({
              where: {
                companyId: invite.companyId,
                userId: request.customer.userId ?? '',
                isActive: true,
              },
            }))
          )
            throw new ForbiddenException('Vínculo do cliente desativado.');
          if (invite.usedAt) {
            if (invite.action !== action)
              throw new ConflictException('Link já utilizado para outra ação.');
            return {
              response: action,
              bookingUrl:
                '/agendar/' + encodeURIComponent(request.company.slug),
            };
          }
          if (
            request.status !== 'CONFIRMED' ||
            c.startsAt <= new Date() ||
            c.response
          )
            throw new ConflictException(
              'A confirmação já foi respondida ou o agendamento foi encerrado.',
            );
          if (action === 'CANCEL') {
            if (!request.customer.userId) throw new ForbiddenException();
            await cancelBookingInTx(
              tx,
              invite.companyId,
              request.id,
              request.customer.userId,
              'Cancelamento solicitado por link de confirmação.',
            );
          }
          await tx.bookingConfirmation.update({
            where: { id: c.id },
            data: { response: action, responseAt: new Date() },
          });
          await tx.bookingConfirmationInvitation.update({
            where: { id: invite.id },
            data: { usedAt: new Date(), action },
          });
          await attendanceEvent(
            tx,
            invite.companyId,
            request.id,
            action === 'CONFIRM'
              ? 'PRESENCE_CONFIRMED'
              : action === 'RESCHEDULE'
                ? 'RESCHEDULE_REQUESTED'
                : 'CANCELLATION_REQUESTED',
            'CONFIRMATION:' + invite.id,
            request.customer.userId ?? undefined,
          );
          if (action === 'RESCHEDULE') {
            const staff = await tx.membership.findMany({
              where: {
                companyId: invite.companyId,
                isActive: true,
                role: { in: ['OWNER', 'ADMIN', 'RECEPTIONIST'] },
              },
              select: { userId: true },
            });
            await tx.notification.createMany({
              data: staff.map((m) => ({
                userId: m.userId,
                companyId: invite.companyId,
                sourceKey: 'reschedule:' + c.id,
                type: 'BOOKING_RESCHEDULE_REQUESTED',
                title: 'Cliente pediu reagendamento',
                message:
                  'Revise a solicitação e combine um novo horário. O agendamento atual permanece ativo até a alteração.',
                actionUrl: '/painel/proprietario',
                actionLabel: 'Ver agenda',
              })),
              skipDuplicates: true,
            });
          }
          await this.ops.notify(tx, invite.companyId);
          return {
            response: action,
            bookingUrl: '/agendar/' + encodeURIComponent(request.company.slug),
          };
        },
        { isolationLevel: 'Serializable', timeout: 10000 },
      ),
    );
  }
  async history(actor: Operator, customerId: string) {
    uuid(customerId);
    if (
      !(await this.db.customerProfile.findFirst({
        where: { id: customerId, companyId: actor.companyId },
      }))
    )
      throw new NotFoundException();
    const requests = await this.db.bookingRequest.findMany({
      where: { companyId: actor.companyId, customerId },
      select: {
        id: true,
        status: true,
        createdAt: true,
        items: {
          select: {
            id: true,
            serviceId: true,
            professionalId: true,
            serviceName: true,
            professional: { select: { displayName: true } },
          },
        },
        confirmation: {
          select: {
            response: true,
            events: {
              select: { type: true, reason: true, createdAt: true },
              orderBy: { createdAt: 'desc' },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const counts = {
      completed: 0,
      cancelled: 0,
      noShows: 0,
      confirmed: 0,
      rescheduleRequests: 0,
      rescheduled: 0,
    };
    for (const r of requests) {
      const latest = r.confirmation?.events.find((e) =>
        ['COMPLETED', 'NO_SHOW', 'ATTENDED'].includes(e.type),
      );
      if (latest?.type === 'COMPLETED' || latest?.type === 'ATTENDED')
        counts.completed++;
      if (latest?.type === 'NO_SHOW') counts.noShows++;
      if (r.status === 'CANCELLED') counts.cancelled++;
      if (r.confirmation?.response === 'CONFIRM') counts.confirmed++;
      if (r.confirmation?.response === 'RESCHEDULE')
        counts.rescheduleRequests++;
      if (r.confirmation?.events.some((e) => e.type === 'RESCHEDULED'))
        counts.rescheduled++;
    }
    return { counts, requests, truncated: requests.length === 200 };
  }
  async review(actor: Operator, id: string, input: unknown) {
    const b = object(input, ['type', 'reason', 'idempotencyKey']),
      type = String(b.type);
    if (!['NO_SHOW', 'ATTENDED'].includes(type))
      throw new BadRequestException('Situação inválida.');
    const reason = string(b.reason, 'reason', 1000),
      key = uuid(b.idempotencyKey);
    return this.ops.change(
      actor,
      ['OWNER', 'ADMIN', 'RECEPTIONIST'],
      async (tx) => {
        const r = await tx.bookingRequest.findFirst({
          where: { companyId: actor.companyId, id },
          include: { items: true },
        });
        if (!r || r.status !== 'CONFIRMED') throw new NotFoundException();
        if (r.items.some((i) => i.startsAt > new Date()))
          throw new ConflictException('Aguarde o horário do atendimento.');
        const old = await tx.bookingAttendanceEvent.findUnique({
          where: {
            companyId_sourceKey: {
              companyId: actor.companyId,
              sourceKey: 'REVIEW:' + key,
            },
          },
        });
        if (old) {
          if (
            old.type !== type ||
            old.reason !== reason ||
            old.confirmationId !==
              (
                await tx.bookingConfirmation.findUnique({
                  where: {
                    requestId_companyId: {
                      requestId: id,
                      companyId: actor.companyId,
                    },
                  },
                })
              )?.id
          )
            throw new ConflictException('Chave já utilizada.');
          return old;
        }
        return attendanceEvent(
          tx,
          actor.companyId,
          id,
          type,
          'REVIEW:' + key,
          actor.userId,
          reason,
        );
      },
    );
  }
  async due(companyIds?: string[]) {
    const origin = new AuthConfig().origins()[0];
    if (!origin) return { queued: 0 };
    let queued = 0;
    const configs = await this.db.bookingConfirmationSettings.findMany({
      where: {
        enabled: true,
        ...(companyIds ? { companyId: { in: companyIds } } : {}),
      },
      take: 50,
    });
    for (const cfg of configs) {
      try {
        await this.entitlements.current(cfg.companyId);
      } catch (e) {
        if (e instanceof ForbiddenException) continue;
        throw e;
      }
      const requests = await this.db.bookingRequest.findMany({
        where: {
          companyId: cfg.companyId,
          status: 'CONFIRMED',
          items: {
            some: {
              startsAt: {
                gt: new Date(),
                lte: new Date(Date.now() + cfg.leadMinutes * 60000),
              },
            },
          },
        },
        include: { items: { orderBy: { startsAt: 'asc' }, take: 1 } },
        orderBy: { createdAt: 'asc' },
        take: 100,
      });
      for (const r of requests) {
        const startsAt = r.items[0]?.startsAt;
        if (!startsAt || startsAt <= new Date()) continue;
        const stage = [...cfg.reminderMinutes]
          .reverse()
          .find((n) => startsAt.getTime() - Date.now() <= n * 60000);
        const stageName = stage === undefined ? 'INITIAL' : 'REMINDER:' + stage;
        const token = randomBytes(32).toString('base64url');
        const created = await withBillingConflictRetry(() =>
          this.db.$transaction(
            async (tx) => {
              await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${cfg.companyId + ':confirmation-request:' + r.id},0))::text`;
              if (
                !(await tx.bookingRequest.findFirst({
                  where: {
                    id: r.id,
                    companyId: cfg.companyId,
                    status: 'CONFIRMED',
                  },
                }))
              )
                return false;
              const deadlineAt = new Date(
                Math.min(
                  startsAt.getTime(),
                  Date.now() + cfg.responseMinutes * 60000,
                ),
              );
              const c = await tx.bookingConfirmation.upsert({
                where: {
                  requestId_companyId: {
                    requestId: r.id,
                    companyId: cfg.companyId,
                  },
                },
                create: {
                  companyId: cfg.companyId,
                  requestId: r.id,
                  startsAt,
                  deadlineAt,
                },
                update: {},
              });
              const name = c.revision + ':' + stageName;
              if (
                c.response ||
                ((c.deadlineResult || c.deadlineAt <= new Date()) &&
                  stageName === 'INITIAL') ||
                (await tx.bookingConfirmationInvitation.findUnique({
                  where: {
                    confirmationId_stage: { confirmationId: c.id, stage: name },
                  },
                }))
              )
                return false;
              if (stageName === 'INITIAL' || c.deadlineAt <= new Date()) {
                await tx.bookingConfirmation.update({
                  where: { id: c.id },
                  data: { deadlineAt, deadlineResult: null },
                });
                c.deadlineAt = deadlineAt;
              }
              const invite = await tx.bookingConfirmationInvitation.create({
                data: {
                  companyId: cfg.companyId,
                  confirmationId: c.id,
                  stage: name,
                  tokenHash: confirmationToken(token),
                  expiresAt: c.deadlineAt,
                },
              });
              const outbox = await queueCustomerEvent(
                tx,
                cfg.companyId,
                r.customerId,
                'OP_APPOINTMENT_CONFIRMATION',
                invite.id,
                {
                  __confirmationInvitationId: invite.id,
                  __allowedChannels: cfg.channels,
                  url_confirmacao: `${origin}/confirmar-agendamento?token=${token}`,
                  servico: r.items
                    .map((i) => i.serviceName)
                    .join(', ')
                    .slice(0, 500),
                  horario: startsAt.toISOString(),
                },
              );
              if (!outbox) {
                await tx.bookingConfirmationInvitation.delete({
                  where: { id: invite.id },
                });
                return false;
              }
              await tx.bookingConfirmationInvitation.update({
                where: { id: invite.id },
                data: { outboxId: outbox.id },
              });
              return true;
            },
            { isolationLevel: 'Serializable', timeout: 10000 },
          ),
        );
        if (created) queued++;
      }
      // No automatic cancellation without an explicit rule AND delivery evidence.
      const expired = await this.db.bookingConfirmation.findMany({
        where: {
          companyId: cfg.companyId,
          response: null,
          deadlineResult: null,
          deadlineAt: { lte: new Date() },
          invitations: { some: {} },
        },
        include: { invitations: true },
        take: 100,
      });
      for (const c of expired)
        await withBillingConflictRetry(() =>
          this.db.$transaction(
            async (tx) => {
              await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${cfg.companyId + ':operations'},0))::text`;
              const activeConfig =
                await tx.bookingConfirmationSettings.findUnique({
                  where: { companyId: cfg.companyId },
                });
              if (!activeConfig?.enabled) return;
              await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${cfg.companyId + ':confirmation:' + c.id},0))::text`;
              const current = await tx.bookingConfirmation.findUniqueOrThrow({
                where: { id: c.id },
              });
              if (current.response || current.deadlineResult) return;
              const request = await tx.bookingRequest.findUniqueOrThrow({
                where: { id: c.requestId },
              });
              let result = 'NO_ACTION';
              const proven = await tx.globalCommunicationDelivery.findFirst({
                where: {
                  outboxId: {
                    in: c.invitations.flatMap((i) =>
                      i.outboxId ? [i.outboxId] : [],
                    ),
                  },
                  status: { in: ['DELIVERED', 'READ'] },
                },
              });
              if (
                activeConfig.noResponseRule === 'CANCEL' &&
                proven &&
                request.status === 'CONFIRMED' &&
                !(await tx.posSale.findFirst({
                  where: {
                    companyId: cfg.companyId,
                    bookingRequestId: request.id,
                    status: { not: 'CANCELLED' },
                  },
                }))
              ) {
                const owner = await tx.membership.findFirst({
                  where: {
                    companyId: cfg.companyId,
                    isActive: true,
                    role: 'OWNER',
                  },
                });
                if (owner) {
                  await cancelBookingInTx(
                    tx,
                    cfg.companyId,
                    request.id,
                    owner.userId,
                    'Regra explícita de ausência de resposta com envio comprovado.',
                  );
                  result = 'CANCELLED_BY_RULE';
                }
              }
              if (
                activeConfig.noResponseRule !== 'NONE' &&
                result !== 'CANCELLED_BY_RULE'
              ) {
                result = 'REVIEW_REQUIRED';
                const staff = await tx.membership.findMany({
                  where: {
                    companyId: cfg.companyId,
                    isActive: true,
                    role: { in: ['OWNER', 'ADMIN', 'RECEPTIONIST'] },
                  },
                  select: { userId: true },
                });
                await tx.notification.createMany({
                  data: staff.map((m) => ({
                    userId: m.userId,
                    companyId: cfg.companyId,
                    sourceKey: 'confirmation-deadline:' + c.id,
                    type: 'BOOKING_CONFIRMATION_REVIEW',
                    title: 'Confirmação precisa de revisão',
                    message:
                      'O prazo encerrou sem resposta. O agendamento foi preservado; revise o atendimento.',
                    actionUrl: '/painel/proprietario',
                    actionLabel: 'Ver agenda',
                  })),
                  skipDuplicates: true,
                });
              }
              await tx.bookingConfirmation.update({
                where: { id: c.id },
                data: { deadlineResult: result },
              });
              const auditor = await tx.membership.findFirst({
                where: { companyId: cfg.companyId, role: 'OWNER' },
                select: { userId: true },
              });
              if (auditor)
                await tx.posAudit.create({
                  data: {
                    companyId: cfg.companyId,
                    actorId: auditor.userId,
                    action: 'CONFIRMATION_DEADLINE',
                    detail: {
                      requestId: request.id,
                      rule: activeConfig.noResponseRule,
                      actorType: 'AUTOMATION',
                      result,
                      deliveryProven: Boolean(proven),
                    },
                  },
                });
            },
            { isolationLevel: 'Serializable', timeout: 10000 },
          ),
        );
    }
    return { queued };
  }
}
