import { adminList, listStatus } from '../common/admin-list.js';
import { pushPayload, pushTargets } from './push.js';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { SecretVault } from '../billing/secret-vault.js';
import { CommunicationConfiguration } from './configuration.js';
import { CommunicationTransports } from './transports.js';
import {
  channels,
  email,
  eventName,
  phone,
  render,
  retry,
  templateContent,
  TransportFailure,
} from './contracts.js';
import type { Message, Variables } from './contracts.js';
import { boolean, object } from '../common/validation.js';
import type { Prisma } from '@prisma/client';
const payloadScope = (id: string) => `communication:GLOBAL:delivery:${id}`;
@Injectable()
export class CommunicationEngine {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(SecretVault) private readonly vault: SecretVault,
    @Inject(CommunicationConfiguration)
    private readonly configuration: CommunicationConfiguration,
    @Inject(CommunicationTransports)
    private readonly transports: CommunicationTransports,
  ) {}
  async template(
    event: string,
    channel: string,
    input: unknown,
    actorId: string,
  ) {
    eventName(event);
    if (!['EMAIL', 'WHATSAPP', 'PUSH'].includes(channel))
      throw new BadRequestException('CHANNEL_INVALID');
    const d = object(input, ['provider', 'enabled', 'content']);
    boolean(d.enabled, 'enabled');
    if (
      typeof d.provider !== 'string' ||
      !Object.hasOwn(channels, d.provider) ||
      channels[d.provider as keyof typeof channels] !== channel
    )
      throw new BadRequestException('PROVIDER_CHANNEL_INVALID');
    const typedChannel = channel as 'EMAIL' | 'WHATSAPP' | 'PUSH';
    const provider = d.provider as keyof typeof channels;
    if (d.enabled && !this.transports.available(provider))
      throw new BadRequestException('PROVIDER_UNAVAILABLE');
    const content = templateContent(
      d.content,
      typedChannel,
      eventName(event),
      provider,
    );
    return this.db.$transaction(async (tx) => {
      const result = await tx.globalCommunicationTemplate.upsert({
        where: { event_channel: { event, channel: typedChannel } },
        create: {
          event,
          channel: typedChannel,
          provider,
          content,
          enabled: d.enabled === true,
        },
        update: {
          provider,
          content,
          enabled: d.enabled === true,
          revision: { increment: 1 },
        },
      });
      await tx.globalCommunicationLog.create({
        data: { actorId, action: `TEMPLATE_UPDATE_${event}_${channel}` },
      });
      return result;
    });
  }
  /** Expansion is atomic; a concurrent worker either sees all deliveries or none. */
  async expand() {
    return this.db.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM "GlobalCommunicationOutbox" WHERE "expandedAt" IS NULL ORDER BY "createdAt", id LIMIT 20 FOR UPDATE SKIP LOCKED`;
        for (const { id } of rows) {
          const event = await tx.globalCommunicationOutbox.findUniqueOrThrow({
            where: { id },
          });
          let name;
          try {
            name = eventName(event.event);
            if (
              !event.companyId &&
              !(name === 'SECURITY_PASSWORD_CHANGED' && event.userId)
            )
              throw new BadRequestException('OUTBOX_RECIPIENT_SCOPE_INVALID');
          } catch {
            await tx.globalCommunicationOutbox.update({
              where: { id },
              data: { expandedAt: new Date(), lastError: 'OUTBOX_INVALID' },
            });
            await tx.globalCommunicationLog.create({
              data: {
                outboxId: id,
                action: 'OUTBOX_REJECTED',
                code: 'OUTBOX_INVALID',
              },
            });
            continue;
          }
          const templates = await tx.globalCommunicationTemplate.findMany({
            where: { event: name, enabled: true },
          });
          const members = await tx.membership.findMany({
            where: {
              companyId: event.companyId ?? undefined,
              role: 'OWNER',
              isActive: true,
              user: { isActive: true },
              ...(event.userId ? { userId: event.userId } : {}),
            },
            orderBy: { companyId: 'asc' },
            include: {
              user: { select: { name: true, email: true, phone: true } },
              company: { select: { name: true } },
            },
          });
          // Security event has an explicit user, never any arbitrary tenant user.
          const unique = new Map(members.map((m) => [m.userId, m]));
          for (const member of unique.values())
            for (const t of templates) {
              if (channels[t.provider] !== t.channel) {
                await tx.globalCommunicationLog.create({
                  data: {
                    outboxId: id,
                    action: 'TEMPLATE_REJECTED',
                    code: 'OUTBOX_CHANNEL_INVALID',
                  },
                });
                continue;
              }
              const cfg = await tx.globalCommunicationProvider.findUnique({
                where: { provider: t.provider },
              });
              if (!cfg?.enabled || cfg.scope !== 'GLOBAL') continue;
              const targets =
                t.channel === 'PUSH'
                  ? await tx.globalPushSubscription.findMany({
                      where: {
                        ...pushTargets({
                          userId: member.userId,
                          environment: cfg.environment,
                          audience: event.companyId ? 'COMPANY' : 'ACCOUNT',
                          ...(event.companyId
                            ? { companyId: event.companyId }
                            : {}),
                        }),
                      },
                      select: { id: true },
                      take: 20,
                    })
                  : [{ id: 'USER' }];
              // Keep a visible non-sendable record when no device exists.
              if (!targets.length) targets.push({ id: 'NO_DEVICE' });
              for (const target of targets) {
                const deliveryId = randomUUID();
                let payloadEncrypted: string | null = null,
                  recipientMasked = 'unavailable';
                let status: 'PENDING' | 'UNSENDABLE' = 'PENDING';
                let lastError: string | null = null;
                let message: Message | undefined;
                try {
                  const to =
                    t.channel === 'EMAIL'
                      ? email(member.user.email)
                      : t.channel === 'WHATSAPP'
                        ? phone(member.user.phone)
                        : target.id === 'NO_DEVICE'
                          ? ''
                          : target.id;
                  if (!to) throw new Error();
                  recipientMasked =
                    t.channel === 'PUSH'
                      ? 'device'
                      : t.channel === 'EMAIL'
                        ? `${to[0]}***@***`
                        : `***${to.slice(-4)}`;
                  message = render(
                    t.content as Variables,
                    t.channel,
                    name,
                    {
                      ...(event.variables as Variables),
                      nome: member.user.name,
                      empresa: member.company.name,
                    },
                    to,
                  );
                  if (t.channel === 'PUSH') pushPayload(message);
                } catch {
                  status = 'UNSENDABLE';
                  message = undefined;
                  lastError = 'RECIPIENT_OR_TEMPLATE_INVALID';
                }
                // Vault failure rolls back expansion and can recover on the next worker invocation.
                if (message)
                  payloadEncrypted = this.vault.encrypt(
                    JSON.stringify(message),
                    payloadScope(deliveryId),
                  );
                await tx.globalCommunicationDelivery.createMany({
                  skipDuplicates: true,
                  data: [
                    {
                      id: deliveryId,
                      outboxId: id,
                      userId: member.userId,
                      targetKey: target.id,
                      channel: t.channel,
                      provider: t.provider,
                      environment: cfg.environment,
                      configurationRevision: cfg.revision,
                      templateId: t.id,
                      templateRevision: t.revision,
                      recipientMasked,
                      payloadEncrypted,
                      status,
                      lastError,
                    },
                  ],
                });
              }
            }
          await tx.globalCommunicationOutbox.update({
            where: { id },
            data: { expandedAt: new Date() },
          });
          await tx.globalCommunicationLog.create({
            data: {
              action: 'OUTBOX_EXPANDED',
              code: unique.size ? 'PROCESSED' : 'NO_OWNER',
            },
          });
        }
        return rows.length;
      },
      { timeout: 15000 },
    );
  }
  async processOne() {
    const now = new Date();
    const candidates = await this.db.globalCommunicationDelivery.findMany({
      where: {
        status: { in: ['PENDING', 'RETRY'] },
        nextAttemptAt: { lte: now },
        attempts: { lt: 5 },
      },
      orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
      take: 10,
    });
    for (const row of candidates) {
      const claimed = await this.db.globalCommunicationDelivery.updateMany({
        where: { id: row.id, status: row.status, attempts: row.attempts },
        data: { status: 'SENDING', startedAt: now, attempts: { increment: 1 } },
      });
      if (!claimed.count) continue;
      let status: 'ACCEPTED' | 'SKIPPED' | 'RETRY' | 'FAILED' | 'UNCERTAIN' =
        'FAILED';
      let code: string | null = null;
      let providerMessageId: string | null = null;
      let nextAttemptAt = now;
      try {
        const event = await this.db.globalCommunicationOutbox.findUniqueOrThrow(
          { where: { id: row.outboxId } },
        );
        if (
          !event.companyId &&
          !(
            event.event === 'SECURITY_PASSWORD_CHANGED' &&
            event.userId === row.userId
          )
        )
          throw new TransportFailure('PERMANENT');
        const member = await this.db.membership.findFirst({
          where: {
            companyId: event.companyId ?? undefined,
            userId: row.userId,
            role: 'OWNER',
            isActive: true,
            user: { isActive: true },
          },
          include: { user: { select: { email: true, phone: true } } },
        });
        const t = await this.db.globalCommunicationTemplate.findUnique({
          where: { id: row.templateId },
        });
        const c = await this.configuration.context(row.provider);
        if (
          !member ||
          !t?.enabled ||
          t.revision !== row.templateRevision ||
          c.row.environment !== row.environment ||
          c.row.revision !== row.configurationRevision
        ) {
          status = 'SKIPPED';
          code = 'AUTHORIZATION_OR_CONFIGURATION_CHANGED';
        } else {
          if (!row.payloadEncrypted) throw new TransportFailure('PERMANENT');
          const message = JSON.parse(
            this.vault.decrypt(row.payloadEncrypted, payloadScope(row.id)),
          ) as Message;
          const current =
            row.channel === 'EMAIL'
              ? email(member.user.email)
              : row.channel === 'WHATSAPP'
                ? phone(member.user.phone)
                : row.targetKey;
          const device =
            row.channel === 'PUSH'
              ? await this.db.globalPushSubscription.findFirst({
                  where: {
                    ...pushTargets({
                      userId: row.userId,
                      environment: row.environment,
                      audience: event.companyId ? 'COMPANY' : 'ACCOUNT',
                      ...(event.companyId
                        ? { companyId: event.companyId }
                        : {}),
                    }),
                    id: row.targetKey,
                  },
                })
              : true;
          if (!device || current !== message.to) {
            status = 'SKIPPED';
            code = 'RECIPIENT_CHANGED';
          } else {
            providerMessageId = await this.transports
              .get(row.provider)
              .send(
                c.config,
                c.secret,
                row.channel === 'PUSH'
                  ? {
                      ...message,
                      pushRecipient: {
                        userId: row.userId,
                        environment: row.environment,
                        audience: event.companyId ? 'COMPANY' : 'ACCOUNT',
                        ...(event.companyId
                          ? { companyId: event.companyId }
                          : {}),
                      },
                    }
                  : message,
              );
            status = 'ACCEPTED';
          }
        }
      } catch (e) {
        const kind = e instanceof TransportFailure ? e.kind : 'PERMANENT';
        code = `COMMUNICATION_${kind}`;
        const next = retry(kind, row.attempts + 1, now);
        status = next ? 'RETRY' : kind === 'UNCERTAIN' ? 'UNCERTAIN' : 'FAILED';
        if (next) nextAttemptAt = next;
      }
      // Crash or DB error here leaves SENDING; it is quarantined, never automatically sent again.
      await this.db.$transaction(async (tx) => {
        const updated = await tx.globalCommunicationDelivery.updateMany({
          where: { id: row.id, status: 'SENDING', attempts: row.attempts + 1 },
          data: {
            status,
            providerMessageId,
            lastError: code,
            nextAttemptAt,
            ...(status === 'RETRY' ? {} : { payloadEncrypted: null }),
          },
        });
        if (updated.count)
          await tx.globalCommunicationLog.create({
            data: {
              deliveryId: row.id,
              action: status,
              code,
              attempt: row.attempts + 1,
            },
          });
        if (status === 'ACCEPTED')
          await tx.globalCommunicationProvider.updateMany({
            where: {
              provider: row.provider,
              revision: row.configurationRevision,
            },
            data: { lastSentAt: new Date() },
          });
      });
      return true;
    }
    return false;
  }
  async run() {
    await this.db.globalCommunicationDelivery.updateMany({
      where: {
        status: 'SENDING',
        startedAt: { lt: new Date(Date.now() - 300000) },
      },
      data: {
        status: 'UNCERTAIN',
        lastError: 'WORKER_INTERRUPTED',
        payloadEncrypted: null,
      },
    });
    const expanded = await this.expand();
    let processed = 0;
    while (processed < 50 && (await this.processOne())) processed++;
    return { expanded, processed };
  }
  async reprocess(id: string, actorId: string) {
    return this.db.$transaction(async (tx) => {
      const updated = await tx.globalCommunicationDelivery.updateMany({
        where: {
          id,
          status: 'RETRY',
          attempts: { lt: 5 },
          payloadEncrypted: { not: null },
        },
        data: { nextAttemptAt: new Date() },
      });
      if (!updated.count)
        throw new ConflictException('DELIVERY_NOT_SAFE_TO_RETRY');
      await tx.globalCommunicationLog.create({
        data: { deliveryId: id, actorId, action: 'RETRY_REQUESTED' },
      });
      return { queued: true };
    });
  }
  /** A temporal fact is based on a persisted trial deadline; no guessed payment due date. */
  async temporal() {
    const now = new Date(),
      horizon = new Date(now.getTime() + 3 * 86400000);
    const inserted = await this.db.$executeRaw`
      INSERT INTO "GlobalCommunicationOutbox" (id, scope, event, "businessKey", "companyId", variables, "createdAt")
      SELECT gen_random_uuid(), 'GLOBAL', 'TRIAL_EXPIRING',
        'TRIAL_EXPIRING:' || s.id::text || ':' || s."trialEndsAt"::text,
        s."companyId", jsonb_build_object('plano',p.name,'dias_trial',ceil(extract(epoch from (s."trialEndsAt" - ${now}::timestamp))/86400)::text,'vencimento',s."trialEndsAt"::text), ${now}
      FROM "Subscription" s JOIN "Plan" p ON p.id=s."planId"
      WHERE s.status='TRIALING' AND s."trialEndsAt">${now} AND s."trialEndsAt"<=${horizon}
      AND NOT EXISTS (SELECT 1 FROM "GlobalCommunicationOutbox" o WHERE o."businessKey"='TRIAL_EXPIRING:' || s.id::text || ':' || s."trialEndsAt"::text)
      ORDER BY s."trialEndsAt",s.id LIMIT 100
      ON CONFLICT ("businessKey") DO NOTHING`;
    return { inserted };
  }

  listDeliveries(
    where: Prisma.GlobalCommunicationDeliveryWhereInput = {},
    query: unknown = {},
  ) {
    const page = adminList(query, ['status']);
    const status = listStatus(page.status, [
      'PENDING',
      'SENDING',
      'ACCEPTED',
      'DELIVERED',
      'READ',
      'RETRY',
      'FAILED',
      'UNSENDABLE',
      'UNCERTAIN',
      'SKIPPED',
    ]);
    return this.db.globalCommunicationDelivery.findMany({
      where: {
        scope: 'GLOBAL',
        AND: [where, ...(status ? [{ status }] : [])],
      },
      take: page.take,
      skip: page.skip,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      omit: { payloadEncrypted: true },
    });
  }
}
