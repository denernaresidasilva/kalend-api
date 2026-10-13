import { adminList, listStatus } from '../common/admin-list.js';
import { pushPayload, pushTargets } from './push.js';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  ForbiddenException,
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
import { boolean, object, uuid } from '../common/validation.js';
import type { Prisma } from '@prisma/client';
import {
  QA_COMMUNICATION_EVENT,
  QA_COMPANY_SLUG,
  allowedRecipient,
  allowlistedRecipient,
  assertQaScope,
  maskQaRecipient,
  normalizeQaDestination,
  qaBusinessKeyPrefix,
  requireQaCommunicationAllowlist,
  type QaChannel,
} from './qa-policy.js';
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
    if (event === QA_COMMUNICATION_EVENT)
      throw new ForbiddenException('QA_TEMPLATE_IS_IMMUTABLE');
    eventName(event);
    if (!['EMAIL', 'WHATSAPP', 'PUSH'].includes(channel))
      throw new BadRequestException('CHANNEL_INVALID');
    const d = object(input, ['provider', 'enabled', 'content']);
    boolean(d.enabled, 'enabled');
    if (
      d.provider !== undefined &&
      (typeof d.provider !== 'string' ||
        !Object.hasOwn(channels, d.provider) ||
        channels[d.provider as keyof typeof channels] !== channel)
    )
      throw new BadRequestException('PROVIDER_CHANNEL_INVALID');
    const typedChannel = channel as 'EMAIL' | 'WHATSAPP' | 'PUSH';
    const provider = (
      channel === 'EMAIL' || d.provider === undefined
        ? await this.configuration.resolveProvider(typedChannel, this.db, false)
        : d.provider
    ) as keyof typeof channels;
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
  /** Creates one allowlisted QA intent; its payload is fixed and never supplied by the caller. */
  async createQaIntent(input: unknown, actorId: string) {
    const allowlist = requireQaCommunicationAllowlist();
    const data = object(input, [
      'companyId',
      'userId',
      'channel',
      'idempotencyKey',
    ]);
    const companyId = uuid(data.companyId);
    const userId = uuid(data.userId);
    const idempotencyKey = uuid(data.idempotencyKey);
    assertQaScope(companyId, userId, allowlist);
    if (!['EMAIL', 'WHATSAPP', 'PUSH'].includes(String(data.channel)))
      throw new BadRequestException('QA_CHANNEL_INVALID');
    const channel = data.channel as QaChannel;
    const company = await this.db.company.findUnique({
      where: { id: companyId },
      select: { id: true, slug: true, name: true, isActive: true },
    });
    const membership = await this.db.membership.findFirst({
      where: {
        companyId,
        userId,
        role: 'OWNER',
        isActive: true,
        user: { isActive: true, isSuperAdmin: false },
      },
      include: {
        user: { select: { id: true, name: true, email: true, phone: true } },
      },
    });
    if (!company?.isActive || company.slug !== QA_COMPANY_SLUG || !membership)
      throw new ForbiddenException('QA_COMMUNICATION_TENANT_INVALID');

    const provider = await this.configuration.resolveProvider(channel);
    if (!provider) throw new BadRequestException('QA_PROVIDER_UNAVAILABLE');
    const providerRow = await this.db.globalCommunicationProvider.findUnique({
      where: { provider },
    });
    if (!providerRow?.enabled || providerRow.scope !== 'GLOBAL')
      throw new ForbiddenException('QA_PROVIDER_NOT_ALLOWED');

    let recipient: string;
    let targetKey = 'USER';
    if (channel === 'EMAIL') recipient = membership.user.email;
    else if (channel === 'WHATSAPP') {
      if (!membership.user.phone)
        throw new ForbiddenException('QA_RECIPIENT_NOT_ALLOWLISTED');
      recipient = membership.user.phone;
    } else {
      const subscriptionId = allowlist.pushSubscriptionId;
      if (!subscriptionId)
        throw new ForbiddenException('QA_RECIPIENT_NOT_ALLOWLISTED');
      const subscription = await this.db.globalPushSubscription.findFirst({
        where: {
          id: subscriptionId,
          userId,
          scope: 'GLOBAL',
          provider: 'WEB_PUSH',
          environment: providerRow.environment,
          active: true,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          authorizations: {
            some: {
              companyId,
              userId,
              active: true,
              revokedAt: null,
            },
          },
        },
        select: { id: true },
      });
      if (!subscription)
        throw new ForbiddenException('QA_PUSH_DEVICE_NOT_AUTHORIZED');
      recipient = subscription.id;
      targetKey = subscription.id;
    }
    const normalized = normalizeQaDestination(channel, recipient);
    const configured = allowlistedRecipient(channel, allowlist);
    if (!normalized || normalized !== configured)
      throw new ForbiddenException('QA_RECIPIENT_NOT_ALLOWLISTED');
    recipient = normalized;

    const content: Variables =
      channel === 'EMAIL'
        ? {
            subject: 'Kalend DEV: teste de comunicação',
            text: 'Mensagem de homologação QA do Kalend. Nenhuma ação é necessária.',
          }
        : channel === 'PUSH'
          ? {
              title: 'Kalend DEV: teste QA',
              text: 'Mensagem de homologação. Nenhuma ação é necessária.',
            }
          : {
              text: 'Mensagem de homologação QA do Kalend. Nenhuma ação é necessária.',
            };
    const businessKey = `${qaBusinessKeyPrefix(companyId)}${idempotencyKey}`;
    const existing = await this.db.globalCommunicationOutbox.findUnique({
      where: { businessKey },
      include: { deliveries: true },
    });
    const existingVariables = existing?.variables;
    const existingChannel =
      existingVariables &&
      typeof existingVariables === 'object' &&
      !Array.isArray(existingVariables)
        ? existingVariables.channel
        : undefined;
    if (existing && (existing.userId !== userId || existingChannel !== channel))
      throw new ConflictException('QA_IDEMPOTENCY_KEY_CONFLICT');
    if (existing?.deliveries.length === 1)
      return {
        outboxId: existing.id,
        event: QA_COMMUNICATION_EVENT,
        channel,
        provider,
        recipient: maskQaRecipient(channel, recipient),
        deliveries: 1,
      };
    if (existing && existing.deliveries.length > 1)
      throw new ConflictException('QA_DELIVERY_CARDINALITY_INVALID');
    const template = await this.db.globalCommunicationTemplate.upsert({
      where: { event_channel: { event: QA_COMMUNICATION_EVENT, channel } },
      create: {
        event: QA_COMMUNICATION_EVENT,
        channel,
        provider,
        enabled: true,
        content,
      },
      update: { provider, enabled: true, content, revision: { increment: 1 } },
    });
    const outbox =
      existing ??
      (await this.db.globalCommunicationOutbox.create({
        data: {
          scope: 'GLOBAL',
          event: QA_COMMUNICATION_EVENT,
          businessKey,
          companyId,
          userId,
          variables: { channel },
          notificationProcessedAt: new Date(),
          expandedAt: new Date(),
        },
        include: { deliveries: true },
      }));
    if (!outbox.deliveries.length) {
      const deliveryId = randomUUID();
      const message = render(
        content,
        channel,
        QA_COMMUNICATION_EVENT,
        {
          nome: membership.user.name,
          empresa: company.name,
        },
        recipient,
      );
      if (channel === 'PUSH') pushPayload(message);
      await this.db.globalCommunicationDelivery.create({
        data: {
          id: deliveryId,
          outboxId: outbox.id,
          userId,
          targetKey,
          channel,
          provider,
          environment: providerRow.environment,
          configurationRevision: providerRow.revision,
          templateId: template.id,
          templateRevision: template.revision,
          recipientMasked: maskQaRecipient(channel, recipient),
          payloadEncrypted: this.vault.encrypt(
            JSON.stringify(message),
            payloadScope(deliveryId),
          ),
          status: 'PENDING',
        },
      });
    }
    await this.db.globalCommunicationLog.create({
      data: {
        outboxId: outbox.id,
        actorId,
        action: 'QA_INTENT_CREATED',
        code: channel,
      },
    });
    return {
      outboxId: outbox.id,
      event: QA_COMMUNICATION_EVENT,
      channel,
      provider,
      recipient: maskQaRecipient(channel, recipient),
      deliveries: 1,
    };
  }
  /** Expansion is atomic; a concurrent worker either sees all deliveries or none. */
  async expand() {
    return this.db.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM "GlobalCommunicationOutbox" WHERE event <> 'QA_COMMUNICATION_TEST' AND "expandedAt" IS NULL AND "notificationProcessedAt" IS NOT NULL ORDER BY "createdAt", id LIMIT 20 FOR UPDATE SKIP LOCKED`;
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
          const blocked = new Map<string, string>();
          for (const member of unique.values())
            for (const t of templates) {
              if (channels[t.provider] !== t.channel) {
                blocked.set(t.channel, 'TEMPLATE_PROVIDER_MISMATCH');
                continue;
              }
              const provider =
                t.provider === 'META'
                  ? t.provider
                  : await this.configuration.resolveProvider(t.channel, tx);
              if (!provider) {
                const configured =
                  await tx.globalCommunicationProvider.findUnique({
                    where: { provider: t.provider },
                  });
                blocked.set(
                  t.channel,
                  !configured
                    ? 'NO_ACTIVE_PROVIDER'
                    : configured.scope !== 'GLOBAL'
                      ? 'PROVIDER_SCOPE_INVALID'
                      : !configured.enabled
                        ? 'PROVIDER_DISABLED'
                        : 'PROVIDER_UNAVAILABLE',
                );
                continue;
              }
              const cfg = await tx.globalCommunicationProvider.findUnique({
                where: { provider },
              });
              if (!cfg) {
                blocked.set(t.channel, 'NO_ACTIVE_PROVIDER');
                continue;
              }
              if (cfg.scope !== 'GLOBAL') {
                blocked.set(t.channel, 'PROVIDER_SCOPE_INVALID');
                continue;
              }
              if (!cfg.enabled) {
                blocked.set(t.channel, 'PROVIDER_DISABLED');
                continue;
              }
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
                      provider,
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
          const failure = [...blocked.values()].sort().join(',') || null;
          await tx.globalCommunicationOutbox.update({
            where: { id },
            data: failure
              ? { lastError: failure }
              : { expandedAt: new Date(), lastError: null },
          });
          if (failure) {
            if (event.lastError !== failure)
              for (const [channel, code] of blocked)
                await tx.globalCommunicationLog.create({
                  data: {
                    outboxId: id,
                    action: `OUTBOX_BLOCKED_${channel}`,
                    code,
                  },
                });
          } else {
            await tx.globalCommunicationLog.create({
              data: {
                outboxId: id,
                action: 'OUTBOX_EXPANDED',
                code: unique.size ? 'PROCESSED' : 'NO_OWNER',
              },
            });
          }
        }
        return rows.length;
      },
      { timeout: 15000 },
    );
  }
  async processOne(qaOnly = false) {
    const allowlist = qaOnly ? requireQaCommunicationAllowlist() : undefined;
    const now = new Date();
    const candidates = await this.db.globalCommunicationDelivery.findMany({
      where: {
        status: { in: ['PENDING', 'RETRY'] },
        nextAttemptAt: { lte: now },
        attempts: { lt: 5 },
        outbox: qaOnly
          ? {
              event: QA_COMMUNICATION_EVENT,
              companyId: allowlist!.companyId,
              userId: allowlist!.userId,
              businessKey: {
                startsWith: qaBusinessKeyPrefix(allowlist!.companyId),
              },
            }
          : { event: { not: QA_COMMUNICATION_EVENT } },
      },
      orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
      take: qaOnly ? 1 : 10,
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
          include: {
            user: { select: { email: true, phone: true, isSuperAdmin: true } },
            company: { select: { slug: true, isActive: true } },
          },
        });
        const t = await this.db.globalCommunicationTemplate.findUnique({
          where: { id: row.templateId },
        });
        if (qaOnly) {
          const channel = row.channel as QaChannel;
          const currentRecipient =
            channel === 'EMAIL'
              ? member?.user.email
              : channel === 'WHATSAPP'
                ? (member?.user.phone ?? '')
                : row.targetKey;
          if (
            event.event !== QA_COMMUNICATION_EVENT ||
            event.companyId !== allowlist!.companyId ||
            event.userId !== allowlist!.userId ||
            !event.businessKey.startsWith(
              qaBusinessKeyPrefix(allowlist!.companyId),
            ) ||
            !member ||
            member.company.slug !== QA_COMPANY_SLUG ||
            !member.company.isActive ||
            member.user.isSuperAdmin ||
            !allowedRecipient(
              channel,
              currentRecipient ?? '',
              row.targetKey,
              allowlist!,
            )
          ) {
            status = 'SKIPPED';
            code = 'QA_SCOPE_REJECTED';
          }
        }
        if (status === 'SKIPPED') {
          // Keep this delivery quarantined; no provider context or external call is made.
        } else {
          let c: Awaited<ReturnType<CommunicationConfiguration['context']>>;
          try {
            c = await this.configuration.context(row.provider);
          } catch (error) {
            if (error instanceof HttpException)
              throw new TransportFailure(
                'CONFIGURATION',
                'PROVIDER_UNAVAILABLE',
              );
            throw error;
          }
          if (
            !member ||
            !t?.enabled ||
            (qaOnly && t.event !== QA_COMMUNICATION_EVENT) ||
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
              providerMessageId = await this.transports.get(row.provider).send(
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
                  : row.provider === 'EVOLUTION'
                    ? { ...message, globalRecipientUserId: row.userId }
                    : message,
              );
              status = 'ACCEPTED';
            }
          }
        }
      } catch (e) {
        const kind = e instanceof TransportFailure ? e.kind : 'UNKNOWN';
        code =
          e instanceof TransportFailure &&
          e.code &&
          /^[A-Z0-9_]{1,64}$/.test(e.code)
            ? e.code
            : `COMMUNICATION_${kind}`;
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
  /** Processes at most one already-created QA delivery and never reads commercial events. */
  async runQaOnly() {
    const allowlist = requireQaCommunicationAllowlist();
    const pending = await this.db.globalCommunicationDelivery.findMany({
      where: {
        status: { in: ['PENDING', 'RETRY'] },
        nextAttemptAt: { lte: new Date() },
        attempts: { lt: 5 },
        outbox: {
          event: QA_COMMUNICATION_EVENT,
          companyId: allowlist.companyId,
          userId: allowlist.userId,
          businessKey: { startsWith: qaBusinessKeyPrefix(allowlist.companyId) },
        },
      },
      take: 2,
      select: { id: true },
    });
    if (pending.length > 1)
      throw new ConflictException('QA_PENDING_DELIVERY_LIMIT_EXCEEDED');
    const processed = pending.length && (await this.processOne(true)) ? 1 : 0;
    return { qaOnly: true, eligible: pending.length, processed };
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
  listOutboxFailures(query: unknown = {}) {
    const page = adminList(query, []);
    return this.db.globalCommunicationOutbox.findMany({
      where: {
        scope: 'GLOBAL',
        expandedAt: null,
        lastError: { not: null },
      },
      take: page.take,
      skip: page.skip,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        event: true,
        companyId: true,
        expandedAt: true,
        lastError: true,
        createdAt: true,
      },
    });
  }
}
