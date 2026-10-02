import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AuthIdentity } from '../auth/auth.types.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { object, boolean } from '../common/validation.js';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function safeNotificationUrl(value: unknown): string | null {
  return typeof value === 'string' &&
    [
      '/conta',
      '/conta#perfil',
      '/conta#seguranca',
      '/conta#preferencias',
      '/conta/notificacoes',
    ].includes(value)
    ? value
    : null;
}
const presentations: Record<string, [string, string, string]> = {
  OWNER_WELCOME: [
    'empresa',
    'Bem-vindo ao Kalend',
    'Sua conta foi vinculada à empresa.',
  ],
  TRIAL_STARTED: [
    'assinatura',
    'Período de teste iniciado',
    'O período de teste da empresa está ativo.',
  ],
  TRIAL_EXPIRING: [
    'assinatura',
    'Seu teste está terminando',
    'Confira sua assinatura antes do fim do período de teste.',
  ],
  TRIAL_EXPIRED: [
    'assinatura',
    'Período de teste encerrado',
    'Confira as opções para regularizar a assinatura.',
  ],
  PAYMENT_PENDING: [
    'pagamento',
    'Pagamento pendente',
    'Existe um pagamento aguardando confirmação.',
  ],
  PAYMENT_APPROVED: [
    'pagamento',
    'Pagamento recebido',
    'O pagamento da empresa foi confirmado.',
  ],
  PAYMENT_FAILED: [
    'pagamento',
    'Pagamento recusado',
    'O pagamento não foi aprovado. Confira a situação da assinatura.',
  ],
  PAYMENT_OVERDUE: [
    'pagamento',
    'Pagamento em atraso',
    'Confira as opções para regularizar o pagamento.',
  ],
  SUBSCRIPTION_GRACE_PERIOD: [
    'assinatura',
    'Assinatura precisa de atenção',
    'A assinatura está no período de regularização.',
  ],
  SUBSCRIPTION_SUSPENDED: [
    'assinatura',
    'Assinatura suspensa',
    'Confira a situação da assinatura da empresa.',
  ],
  SUBSCRIPTION_REACTIVATED: [
    'assinatura',
    'Assinatura reativada',
    'A assinatura da empresa está ativa novamente.',
  ],
  SUBSCRIPTION_CANCELLED: [
    'assinatura',
    'Assinatura cancelada',
    'O cancelamento da assinatura foi registrado.',
  ],
  SECURITY_PASSWORD_CHANGED: [
    'seguranca',
    'Senha alterada',
    'A senha da sua conta foi alterada.',
  ],
};
export function decodeCursor(value: string) {
  try {
    if (value.length > 250) throw Error();
    const parsed: unknown = JSON.parse(
      Buffer.from(value, 'base64url').toString(),
    );
    const v = object(parsed, ['id', 'createdAt']);
    if (
      typeof v.id !== 'string' ||
      !uuid.test(v.id) ||
      typeof v.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(v.createdAt))
    )
      throw Error();
    return { id: v.id, createdAt: new Date(v.createdAt) };
  } catch {
    throw new BadRequestException('Cursor de notificações inválido.');
  }
}
@Injectable()
export class NotificationsService {
  constructor(@Inject(PrismaService) private readonly db: PrismaService) {}
  async now(tx: Prisma.TransactionClient = this.db) {
    const [row] = await tx.$queryRaw<
      { now: Date }[]
    >`SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AS now`;
    return row.now;
  }
  async scope(
    auth: AuthIdentity,
    now: Date,
  ): Promise<Prisma.NotificationWhereInput> {
    const companyId = auth.session.selectedCompanyId;
    if (companyId) {
      const membership = await this.db.membership.findFirst({
        where: {
          userId: auth.user.id,
          companyId,
          isActive: true,
          company: { isActive: true },
        },
      });
      if (!membership)
        throw new ForbiddenException('Empresa sem vínculo autorizado.');
    }
    return {
      userId: auth.user.id,
      expiresAt: { gt: now },
      OR: [{ companyId: null }, ...(companyId ? [{ companyId }] : [])],
    };
  }
  async count(auth: AuthIdentity) {
    const serverNow = await this.now();
    const where = await this.scope(auth, serverNow);
    const unreadCount = await this.db.notification.count({
      where: { ...where, readAt: null },
    });
    return {
      unreadCount,
      serverNow,
      companyId: auth.session.selectedCompanyId,
    };
  }
  async list(auth: AuthIdentity, query: Record<string, string> = {}) {
    object(query, ['filter', 'cursor', 'limit']);
    const filter = query.filter ?? 'all';
    if (!['all', 'unread', 'read'].includes(filter))
      throw new BadRequestException('Filtro inválido.');
    const limit = query.limit === undefined ? 20 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 20)
      throw new BadRequestException('Limite inválido.');
    const serverNow = await this.now();
    const where = await this.scope(auth, serverNow);
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    const items = await this.db.notification.findMany({
      where: {
        AND: [
          where,
          ...(filter === 'unread'
            ? [{ readAt: null }]
            : filter === 'read'
              ? [{ readAt: { not: null } }]
              : []),
          ...(cursor
            ? [
                {
                  OR: [
                    { createdAt: { lt: cursor.createdAt } },
                    { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                  ],
                },
              ]
            : []),
        ],
      },
      take: limit + 1,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        type: true,
        title: true,
        message: true,
        actionUrl: true,
        actionLabel: true,
        companyId: true,
        company: { select: { name: true } },
        createdAt: true,
        expiresAt: true,
        readAt: true,
      },
    });
    const more = items.length > limit;
    const page = items.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((n) => ({
        ...n,
        actionUrl: safeNotificationUrl(n.actionUrl),
        scope: n.companyId ? 'COMPANY' : 'GLOBAL',
      })),
      nextCursor:
        more && last
          ? Buffer.from(
              JSON.stringify({
                id: last.id,
                createdAt: last.createdAt.toISOString(),
              }),
            ).toString('base64url')
          : null,
      serverNow,
      companyId: auth.session.selectedCompanyId,
    };
  }
  async read(auth: AuthIdentity, id?: string) {
    const serverNow = await this.now();
    const scope = await this.scope(auth, serverNow);
    if (id) {
      const found = await this.db.notification.findFirst({
        where: { AND: [scope, { id }] },
        select: { id: true },
      });
      if (!found) throw new NotFoundException('Notificação não encontrada.');
    }
    const result = await this.db.notification.updateMany({
      where: { AND: [scope, { readAt: null }, ...(id ? [{ id }] : [])] },
      data: { readAt: serverNow },
    });
    return {
      updated: result.count,
      serverNow,
      companyId: auth.session.selectedCompanyId,
    };
  }
  async preferences(auth: AuthIdentity) {
    const row = await this.db.notificationPreference.findUnique({
      where: { userId: auth.user.id },
    });
    return { inSystemEnabled: row?.inSystemEnabled ?? true };
  }
  async setPreferences(auth: AuthIdentity, input: unknown) {
    const body = object(input, ['inSystemEnabled']);
    boolean(body.inSystemEnabled, 'inSystemEnabled');
    if (typeof body.inSystemEnabled !== 'boolean')
      throw new BadRequestException('Preferência obrigatória.');
    const result = await this.db.notificationPreference.upsert({
      where: { userId: auth.user.id },
      create: {
        userId: auth.user.id,
        inSystemEnabled: body.inSystemEnabled as boolean,
      },
      update: { inSystemEnabled: body.inSystemEnabled as boolean },
    });
    return { inSystemEnabled: result.inSystemEnabled };
  }
  /** Separate outbox cursor: inbox creation does not require any enabled delivery channel. */
  async ingest() {
    return this.db.$transaction(async (tx) => {
      const now = await this.now(tx);
      const rows = await tx.$queryRaw<
        { id: string; recent: boolean }[]
      >`SELECT id, ("createdAt" > LOCALTIMESTAMP - INTERVAL '168 hours') AS recent FROM "GlobalCommunicationOutbox" WHERE "notificationProcessedAt" IS NULL ORDER BY "createdAt", id LIMIT 100 FOR UPDATE SKIP LOCKED`;
      let created = 0;
      for (const { id, recent } of rows) {
        const event = await tx.globalCommunicationOutbox.findUniqueOrThrow({
          where: { id },
        });
        const presentation = presentations[event.event];
        if (
          presentation &&
          recent &&
          (event.companyId ||
            (event.event === 'SECURITY_PASSWORD_CHANGED' && event.userId))
        ) {
          const recipients =
            event.event === 'SECURITY_PASSWORD_CHANGED' && event.userId
              ? await tx.user.findMany({
                  where: { id: event.userId, isActive: true },
                  select: { id: true },
                })
              : (
                  await tx.membership.findMany({
                    where: {
                      companyId: event.companyId!,
                      role: 'OWNER',
                      isActive: true,
                      user: { isActive: true },
                      ...(event.userId ? { userId: event.userId } : {}),
                    },
                    select: { userId: true },
                  })
                ).map((m) => ({ id: m.userId }));
          const ids = [...new Set(recipients.map((m) => m.id))];
          const disabled = await tx.notificationPreference.findMany({
            where: { userId: { in: ids }, inSystemEnabled: false },
            select: { userId: true },
          });
          const excluded = new Set(disabled.map((p) => p.userId));
          const result = await tx.notification.createMany({
            skipDuplicates: true,
            data: ids
              .filter((userId) => !excluded.has(userId))
              .map((userId) => ({
                userId,
                companyId: event.companyId,
                sourceKey: event.id,
                type: presentation[0],
                title: presentation[1],
                message: presentation[2],
                createdAt: now,
                actionUrl:
                  event.event === 'SECURITY_PASSWORD_CHANGED'
                    ? '/conta#seguranca'
                    : '/conta',
                actionLabel:
                  event.event === 'SECURITY_PASSWORD_CHANGED'
                    ? 'Ver segurança'
                    : 'Ver minha conta',
              })),
          });
          created += result.count;
        }
        await tx.globalCommunicationOutbox.update({
          where: { id },
          data: { notificationProcessedAt: now },
        });
      }
      return { processed: rows.length, created };
    });
  }
  /** Bounded physical deletion by the existing externally supervised scheduler, never a browser timer. */
  async cleanup() {
    const rows = await this.db.$queryRaw<
      { id: string }[]
    >`DELETE FROM "Notification" WHERE id IN (SELECT id FROM "Notification" WHERE "expiresAt" <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') ORDER BY "expiresAt", id LIMIT 1000 FOR UPDATE SKIP LOCKED) RETURNING id`;
    return { deleted: rows.length };
  }
}
