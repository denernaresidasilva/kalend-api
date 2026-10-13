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
import { resolveEffectiveTemplate } from './company-templates.js';
import { boolean, object, uuid } from '../common/validation.js';
import { Prisma } from '@prisma/client';
import {
  QA_COMMUNICATION_EVENT,
  allowedRecipient,
  assertQaScope,
  isQaCompany,
  maskQaRecipient,
  normalizeQaDestination,
  qaRuntimeEnvironment,
  qaBusinessKeyPrefix,
  requireQaCommunicationAllowlist,
  type QaChannel,
} from './qa-policy.js';
import { evolutionGlobalName } from './evolution-environment.js';
import { normalizeBrazilianPhone } from './recipient.js';
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
  private async qaEvolutionIsSafe() {
    const environment = qaRuntimeEnvironment();
    if (environment !== 'DEV') return false;
    const connection = await this.db.evolutionConnection.findUnique({
      where: { globalKey: 'GLOBAL' },
      select: {
        environment: true,
        instanceName: true,
        status: true,
        prepared: true,
      },
    });
    return (
      connection?.environment === 'DEV' &&
      connection.instanceName === evolutionGlobalName('DEV') &&
      connection.status === 'CONNECTED' &&
      connection.prepared
    );
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
      select: { id: true, name: true, isActive: true },
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
    if (!company?.isActive || !isQaCompany(companyId, allowlist) || !membership)
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
      const subscription = await this.db.globalPushSubscription.findFirst({
        where: {
          ...(allowlist.pushSubscriptionIds.length
            ? { id: { in: allowlist.pushSubscriptionIds } }
            : {}),
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
    if (!normalized || !allowedRecipient(channel, normalized, targetKey, allowlist))
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
  /** Expansion is atomic; company filters are applied in SQL before rows are locked. */
  async expand(options: {
    companyIds?: string[];
    maxEvents?: number;
    qaMode?: boolean;
    progress?: { deliveriesCreated: number };
  } = {}) {
    if (options.companyIds && !options.companyIds.length) return 0;
    const qaAllowlist = options.qaMode
      ? requireQaCommunicationAllowlist()
      : undefined;
    if (
      qaAllowlist &&
      options.companyIds?.some((id) => !isQaCompany(id, qaAllowlist))
    )
      throw new ForbiddenException('QA_COMMUNICATION_SCOPE_MISMATCH');
    const limit = Math.max(1, Math.min(options.maxEvents ?? 20, 20));
    const companyFilter = options.companyIds
      ? Prisma.sql`AND "companyId" IN (${Prisma.join(options.companyIds)})`
      : Prisma.empty;
    return this.db.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<
          { id: string }[]
        >(Prisma.sql`SELECT id FROM "GlobalCommunicationOutbox" WHERE event <> 'QA_COMMUNICATION_TEST' AND "expandedAt" IS NULL AND "notificationProcessedAt" IS NOT NULL ${companyFilter} ORDER BY "createdAt", id LIMIT ${limit} FOR UPDATE SKIP LOCKED`);
        let qaDeliveriesCreated = 0;
        eventLoop: for (const { id } of rows) {
          const event = await tx.globalCommunicationOutbox.findUniqueOrThrow({
            where: { id },
          });
          if (
            options.companyIds &&
            !options.companyIds.includes(event.companyId ?? '')
          )
            continue;
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
          const [globalTemplates, companyTemplates] = await Promise.all([
            tx.globalCommunicationTemplate.findMany({
              where: { event: name, scope: 'GLOBAL' },
            }),
            event.companyId
              ? tx.companyCommunicationTemplate.findMany({
                  where: { event: name, companyId: event.companyId },
                })
              : Promise.resolve([]),
          ]);
          const globalByChannel = new Map(
            globalTemplates.map((template) => [template.channel, template]),
          );
          const companyByChannel = new Map(
            companyTemplates.map((template) => [template.channel, template]),
          );
          const channelsToResolve = new Set([
            ...globalByChannel.keys(),
            ...companyByChannel.keys(),
          ]);
          const templates = [...channelsToResolve]
            .map((channel) => {
              const selected = resolveEffectiveTemplate(
                globalByChannel.get(channel),
                companyByChannel.get(channel),
              );
              if (!selected?.enabled) return null;
              return {
                ...selected,
                channel,
                provider: selected.source === 'GLOBAL' ? selected.provider : undefined,
              };
            })
            .filter((template) => template !== null);
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
          let deliveryLimitReached = false;
          for (const member of unique.values()) {
            for (const t of templates) {
              if (options.qaMode && qaDeliveriesCreated >= 20) {
                deliveryLimitReached = true;
                break;
              }
              if (t.provider && channels[t.provider] !== t.channel) {
                blocked.set(t.channel, 'TEMPLATE_PROVIDER_MISMATCH');
                continue;
              }
              const provider =
                t.provider === 'META'
                  ? t.provider
                  : await this.configuration.resolveProvider(t.channel, tx);
              if (!provider) {
                const candidateProvider =
                  t.provider ??
                  (Object.keys(channels).find(
                    (name) => channels[name as keyof typeof channels] === t.channel,
                  ) as keyof typeof channels);
                const configured = await tx.globalCommunicationProvider.findUnique({
                  where: { provider: candidateProvider },
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
              if (
                options.qaMode &&
                !isQaCompany(event.companyId, qaAllowlist!)
              )
                continue;
              if (
                options.qaMode &&
                provider === 'EVOLUTION' &&
                !(await this.qaEvolutionIsSafe())
              ) {
                blocked.set(t.channel, 'QA_EVOLUTION_ENVIRONMENT_UNSAFE');
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
                        ...(options.qaMode &&
                        qaAllowlist!.pushSubscriptionIds.length
                          ? { id: { in: qaAllowlist!.pushSubscriptionIds } }
                          : {}),
                      },
                      select: { id: true },
                      take: 20,
                    })
                  : [{ id: 'USER' }];
              // Keep a visible non-sendable record when no device exists.
              if (!targets.length) targets.push({ id: 'NO_DEVICE' });
              for (const target of targets) {
                if (options.qaMode && qaDeliveriesCreated >= 20) {
                  deliveryLimitReached = true;
                  break;
                }
                const deliveryId = randomUUID();
                let payloadEncrypted: string | null = null,
                  recipientMasked = 'unavailable';
                let status: 'PENDING' | 'UNSENDABLE' = 'PENDING';
                let lastError: string | null = null;
                let message: Message | undefined;
                if (options.qaMode && target.id === 'NO_DEVICE') {
                  status = 'UNSENDABLE';
                  lastError = 'NO_QA_PUSH_SUBSCRIPTION';
                } else if (
                  options.qaMode &&
                  (t.channel === 'EMAIL' || t.channel === 'WHATSAPP')
                ) {
                  const candidate =
                    t.channel === 'EMAIL'
                      ? normalizeQaDestination('EMAIL', member.user.email)
                      : normalizeBrazilianPhone(member.user.phone ?? undefined);
                  if (
                    !candidate ||
                    !allowedRecipient(
                      t.channel,
                      candidate,
                      target.id,
                      qaAllowlist!,
                    )
                  ) {
                    status = 'UNSENDABLE';
                    lastError = 'QA_RECIPIENT_NOT_ALLOWED';
                  }
                }
                try {
                  if (status === 'UNSENDABLE') throw new Error('QA_BLOCKED');
                  const to =
                    t.channel === 'EMAIL'
                      ? email(member.user.email)
                      : t.channel === 'WHATSAPP'
                        ? options.qaMode
                          ? normalizeBrazilianPhone(member.user.phone ?? undefined) ?? ''
                          : phone(member.user.phone)
                        : target.id === 'NO_DEVICE'
                          ? ''
                          : target.id;
                  if (!to) throw new Error();
                  if (
                    options.qaMode &&
                    t.channel === 'EMAIL' &&
                    !allowedRecipient(
                      'EMAIL',
                      to,
                      target.id,
                      qaAllowlist!,
                    )
                  ) {
                    status = 'UNSENDABLE';
                    lastError = 'QA_RECIPIENT_NOT_ALLOWED';
                    throw new Error('QA_BLOCKED');
                  }
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
                  if (status !== 'UNSENDABLE') status = 'UNSENDABLE';
                  message = undefined;
                  lastError ??= 'RECIPIENT_OR_TEMPLATE_INVALID';
                }
                // Vault failure rolls back expansion and can recover on the next worker invocation.
                if (message)
                  payloadEncrypted = this.vault.encrypt(
                    JSON.stringify(message),
                    payloadScope(deliveryId),
                  );
                const created = await tx.globalCommunicationDelivery.createMany({
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
                      templateScope: t.source,
                      recipientMasked,
                      payloadEncrypted,
                      status,
                      lastError,
                    },
                  ],
                });
                if (options.qaMode) {
                  qaDeliveriesCreated += created.count;
                  if (options.progress)
                    options.progress.deliveriesCreated = qaDeliveriesCreated;
                }
              }
              if (deliveryLimitReached) break;
            }
            if (deliveryLimitReached) break;
          }
          if (deliveryLimitReached) {
            if (options.qaMode)
              console.info(
                JSON.stringify({
                  mode: 'QA',
                  phase: 'expand-deferred',
                  companyId: event.companyId,
                  eventId: event.id,
                  event: event.event,
                  createdDeliveries: qaDeliveriesCreated,
                }),
              );
            break eventLoop;
          }
          const failure = [...blocked.values()].sort().join(',') || null;
          await tx.globalCommunicationOutbox.update({
            where: { id },
            data: failure
              ? { lastError: failure }
              : { expandedAt: new Date(), lastError: null },
          });
          if (options.qaMode)
            console.info(
              JSON.stringify({
                mode: 'QA',
                phase: 'event-expansion',
                companyId: event.companyId,
                eventId: event.id,
                event: event.event,
                result: failure ? 'BLOCKED' : 'EXPANDED',
                code: failure,
              }),
            );
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
  async processOne(options: {
    qaMode?: boolean;
    companyIds?: string[];
    onResult?: (status: 'ACCEPTED' | 'SKIPPED' | 'RETRY' | 'FAILED' | 'UNCERTAIN') => void;
  } = {}) {
    const qaMode = options.qaMode === true;
    const allowlist = qaMode ? requireQaCommunicationAllowlist() : undefined;
    const companyIds = qaMode ? allowlist!.companyIds : options.companyIds;
    if (qaMode && !companyIds?.length)
      throw new ForbiddenException('QA_COMMUNICATION_SCOPE_NOT_CONFIGURED');
    const now = new Date();
    const candidates = await this.db.globalCommunicationDelivery.findMany({
      where: {
        status: { in: ['PENDING', 'RETRY'] },
        nextAttemptAt: { lte: now },
        attempts: { lt: 5 },
        outbox: qaMode
          ? { companyId: { in: companyIds } }
          : { event: { not: QA_COMMUNICATION_EVENT } },
      },
      orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
      take: qaMode ? 20 : 10,
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
      let qaLogContext:
        | { companyId: string | null; eventId: string; event: string }
        | undefined;
      try {
        const event = await this.db.globalCommunicationOutbox.findUniqueOrThrow(
          { where: { id: row.outboxId } },
        );
        if (qaMode)
          qaLogContext = {
            companyId: event.companyId,
            eventId: event.id,
            event: event.event,
          };
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
          company: { select: { isActive: true } },
          },
        });
        const t =
          row.templateScope === 'COMPANY' && event.companyId
            ? await this.db.companyCommunicationTemplate.findUnique({
                where: { id: row.templateId },
              })
            : await this.db.globalCommunicationTemplate.findUnique({
                where: { id: row.templateId },
              });
        if (qaMode) {
          const channel = row.channel as QaChannel;
          const currentRecipient =
            channel === 'EMAIL'
              ? member?.user.email
              : channel === 'WHATSAPP'
                ? (normalizeBrazilianPhone(member?.user.phone ?? undefined) ?? '')
                : row.targetKey;
          if (
            !isQaCompany(event.companyId, allowlist!) ||
            !member ||
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
                  ? qaMode
                    ? normalizeBrazilianPhone(member.user.phone ?? undefined) ?? ''
                    : phone(member.user.phone)
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
              code = qaMode && row.channel === 'PUSH'
                ? 'NO_QA_PUSH_SUBSCRIPTION'
                : 'RECIPIENT_CHANGED';
            } else {
              if (qaMode && row.provider === 'EVOLUTION' && !(await this.qaEvolutionIsSafe())) {
                status = 'SKIPPED';
                code = 'QA_EVOLUTION_ENVIRONMENT_UNSAFE';
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
      let resultPersisted = false;
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
        if (updated.count) {
          resultPersisted = true;
          await tx.globalCommunicationLog.create({
            data: {
              deliveryId: row.id,
              action: qaMode ? `QA_${status}` : status,
              code,
              attempt: row.attempts + 1,
            },
          });
        }
        if (status === 'ACCEPTED')
          await tx.globalCommunicationProvider.updateMany({
            where: {
              provider: row.provider,
              revision: row.configurationRevision,
            },
            data: { lastSentAt: new Date() },
        });
      });
      if (resultPersisted) options.onResult?.(status);
      if (qaMode)
        console.info(
          JSON.stringify({
            mode: 'QA',
            phase: 'delivery-result',
            companyId: qaLogContext?.companyId ?? null,
            eventId: qaLogContext?.eventId ?? row.outboxId,
            event: qaLogContext?.event ?? null,
            deliveryId: row.id,
            channel: row.channel,
            status,
            code,
          }),
        );
      return true;
    }
    return false;
  }
  async run() {
    const recovered = await this.db.globalCommunicationDelivery.updateMany({
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
    const outcomes = {
      ACCEPTED: 0,
      SKIPPED: 0,
      RETRY: 0,
      FAILED: 0,
      UNCERTAIN: 0,
    };
    while (
      processed < 50 &&
      (await this.processOne({
        onResult: (status) => { outcomes[status]++; },
      }))
    ) processed++;
    return { expanded, processed, recovered: recovered.count, outcomes };
  }
  /** Preflight is read-only: it reports only identifiers, masked recipients and counts. */
  async qaPreflight(workerEnabled = process.env.COMMUNICATION_WORKER_ENABLED === 'true') {
    const allowlist = requireQaCommunicationAllowlist();
    const companies = await this.db.company.findMany({
      where: { id: { in: allowlist.companyIds } },
      select: { id: true, name: true, isActive: true },
    });
    const pendingEvents = await this.db.globalCommunicationOutbox.findMany({
      where: {
        companyId: { in: allowlist.companyIds },
        OR: [{ expandedAt: null }, { notificationProcessedAt: null }],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 5,
      select: {
        id: true,
        event: true,
        companyId: true,
        userId: true,
        expandedAt: true,
        notificationProcessedAt: true,
      },
    });
    const nonQaUnexpandedEvents = await this.db.globalCommunicationOutbox.count({
      where: {
        expandedAt: null,
        OR: [
          { companyId: null },
          { companyId: { notIn: allowlist.companyIds } },
        ],
      },
    });
    const deliveries = await this.db.globalCommunicationDelivery.findMany({
      where: {
        status: { in: ['PENDING', 'RETRY'] },
        nextAttemptAt: { lte: new Date() },
        attempts: { lt: 5 },
        outbox: { companyId: { in: allowlist.companyIds } },
      },
      orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
      take: 20,
      select: {
        id: true,
        channel: true,
        status: true,
        recipientMasked: true,
        outbox: { select: { id: true, event: true, companyId: true } },
      },
    });
    const owners = await this.db.membership.findMany({
      where: {
        companyId: { in: allowlist.companyIds },
        role: 'OWNER',
        isActive: true,
        company: { isActive: true },
        user: { isActive: true, isSuperAdmin: false },
      },
      select: {
        companyId: true,
        userId: true,
        user: { select: { email: true, phone: true } },
      },
    });
    const pendingEventNames = [...new Set(pendingEvents.map((event) => event.event))];
    const [templates, companyTemplates] = await Promise.all([
      this.db.globalCommunicationTemplate.findMany({
        where: { scope: 'GLOBAL', event: { in: pendingEventNames } },
        select: { event: true, channel: true, enabled: true },
      }),
      this.db.companyCommunicationTemplate.findMany({
        where: {
          companyId: { in: allowlist.companyIds },
          event: { in: pendingEventNames },
        },
        select: { companyId: true, event: true, channel: true, enabled: true },
      }),
    ]);
    const providers = await this.db.globalCommunicationProvider.findMany({
      where: { scope: 'GLOBAL' },
      select: { provider: true, enabled: true, status: true, environment: true },
    });
    const evolution = await this.db.evolutionConnection.findUnique({
      where: { globalKey: 'GLOBAL' },
      select: { instanceName: true, environment: true, status: true, prepared: true },
    });
    const pushSubscriptions = await this.db.globalPushSubscription.count({
      where: {
        ...(allowlist.pushSubscriptionIds.length
          ? { id: { in: allowlist.pushSubscriptionIds } }
          : {}),
        userId: { in: owners.map((owner) => owner.userId) },
        scope: 'GLOBAL',
        provider: 'WEB_PUSH',
        environment:
          providers.find((row) => row.provider === 'PUSH_PENDING')?.environment ??
          undefined,
        active: true,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        authorizations: {
          some: {
            companyId: { in: allowlist.companyIds },
            active: true,
            revokedAt: null,
          },
        },
      },
    });
    const missingCompanies = allowlist.companyIds.filter(
      (id) => !companies.some((company) => company.id === id && company.isActive),
    );
    const permittedEmailRecipients = owners
      .map((owner) => normalizeQaDestination('EMAIL', owner.user.email))
      .filter((recipient): recipient is string =>
        !!recipient && allowedRecipient('EMAIL', recipient, 'USER', allowlist),
      );
    const permittedPhoneRecipients = owners
      .map((owner) => normalizeBrazilianPhone(owner.user.phone ?? undefined))
      .filter((recipient): recipient is string =>
        !!recipient &&
        allowedRecipient('WHATSAPP', recipient, 'USER', allowlist),
      );
    const possibleDeliveries = { EMAIL: 0, WHATSAPP: 0, PUSH: 0 };
    const possibleRecipients: Record<string, Set<string>> = {
      EMAIL: new Set(),
      WHATSAPP: new Set(),
      PUSH: new Set(),
    };
    const channels: QaChannel[] = ['EMAIL', 'WHATSAPP', 'PUSH'];
    const pushProvider = providers.find((row) => row.provider === 'PUSH_PENDING' && row.enabled);
    for (const event of pendingEvents) {
      if (event.expandedAt || !event.companyId) continue;
      const eventOwners = owners.filter(
        (owner) =>
          owner.companyId === event.companyId &&
          (!event.userId || owner.userId === event.userId),
      );
      for (const channel of channels) {
        const global = templates.find(
          (template) => template.event === event.event && template.channel === channel,
        );
        const company = companyTemplates.find(
          (template) =>
            template.companyId === event.companyId &&
            template.event === event.event &&
            template.channel === channel,
        );
        if (!resolveEffectiveTemplate(global, company)?.enabled) continue;
        if (channel === 'EMAIL') {
          for (const owner of eventOwners) {
            const recipient = normalizeQaDestination('EMAIL', owner.user.email);
            if (recipient && allowedRecipient('EMAIL', recipient, 'USER', allowlist))
              possibleRecipients.EMAIL.add(`${event.id}|${maskQaRecipient('EMAIL', recipient)}`);
          }
        } else if (channel === 'WHATSAPP') {
          for (const owner of eventOwners) {
            const recipient = normalizeBrazilianPhone(owner.user.phone ?? undefined);
            if (recipient && allowedRecipient('WHATSAPP', recipient, 'USER', allowlist))
              possibleRecipients.WHATSAPP.add(`${event.id}|${maskQaRecipient('WHATSAPP', recipient)}`);
          }
        } else if (pushProvider) {
          for (const owner of eventOwners) {
            const devices = await this.db.globalPushSubscription.findMany({
              where: {
                ...pushTargets({
                  userId: owner.userId,
                  environment: pushProvider.environment,
                  audience: 'COMPANY',
                  companyId: event.companyId,
                }),
                ...(allowlist.pushSubscriptionIds.length
                  ? { id: { in: allowlist.pushSubscriptionIds } }
                  : {}),
              },
              select: { id: true },
              take: 20,
            });
            for (const device of devices)
              possibleRecipients.PUSH.add(`${event.id}|${device.id}`);
          }
        }
      }
    }
    possibleDeliveries.EMAIL = possibleRecipients.EMAIL.size;
    possibleDeliveries.WHATSAPP = possibleRecipients.WHATSAPP.size;
    possibleDeliveries.PUSH = possibleRecipients.PUSH.size;
    const resolvedProvider = {
      EMAIL: await this.configuration.resolveProvider('EMAIL'),
      WHATSAPP: await this.configuration.resolveProvider('WHATSAPP'),
      PUSH: await this.configuration.resolveProvider('PUSH'),
    };
    const channelProvider = Object.fromEntries(
      Object.entries(resolvedProvider).map(([channel, provider]) => [
        channel,
        providers.find((row) => row.provider === provider),
      ]),
    ) as Record<string, (typeof providers)[number] | undefined>;
    const safeToRun =
      workerEnabled &&
      missingCompanies.length === 0 &&
      companies.length === allowlist.companyIds.length &&
      ['DEV', 'STAGING'].includes(allowlist.environment);
    return {
      mode: 'QA',
      environment: allowlist.environment,
      qaCompanies: companies.map(({ id, name, isActive }) => ({ id, name, isActive })),
      missingOrInactiveCompanyCount: missingCompanies.length,
      qaEventsPending: pendingEvents.map((event) => ({
        eventId: event.id,
        event: event.event,
        companyId: event.companyId,
        expanded: !!event.expandedAt,
        notificationProcessed: !!event.notificationProcessedAt,
      })),
      nonQaEventsSelected: 0,
      nonQaUnexpandedEventsNotSelected: nonQaUnexpandedEvents,
      pendingDeliveries: deliveries.map((delivery) => ({
        deliveryId: delivery.id,
        eventId: delivery.outbox.id,
        event: delivery.outbox.event,
        companyId: delivery.outbox.companyId,
        channel: delivery.channel,
        status: delivery.status,
        recipient: delivery.recipientMasked,
      })),
      activeOwnerCount: owners.length,
      emailRecipients: {
        allowed: permittedEmailRecipients.length,
        masked: permittedEmailRecipients.map((recipient) => maskQaRecipient('EMAIL', recipient)),
      },
      whatsappRecipients: {
        allowed: permittedPhoneRecipients.length,
        masked: permittedPhoneRecipients.map((recipient) => maskQaRecipient('WHATSAPP', recipient)),
      },
      pushSubscriptions,
      possibleDeliveries,
      possibleRecipients: Object.fromEntries(
        Object.entries(possibleRecipients).map(([channel, recipients]) => [
          channel,
          [...recipients].map((value) =>
            channel === 'PUSH'
              ? 'QA device'
              : value.slice(value.indexOf('|') + 1),
          ),
        ]),
      ),
      providers: Object.fromEntries(
        Object.entries(channelProvider).map(([channel, row]) => [
          channel,
          row
            ? {
                configured: true,
                resolvedProvider: row.provider,
                status: row.status,
                environment: row.environment,
              }
            : { configured: false },
        ]),
      ),
      evolution: evolution
        ? {
            instanceName: evolution.instanceName,
            environment: evolution.environment,
            status: evolution.status,
            safeForQa: await this.qaEvolutionIsSafe(),
          }
        : { configured: false, safeForQa: false },
      limits: { events: 5, deliveries: 20 },
      workerEnabled,
      safeToRun,
    };
  }

  /** Same commercial engine with SQL-scoped claims, ingestion, and recipient guardrails. */
  async runQaWorker(
    ingest: (options: { companyIds: string[]; limit: number }) => Promise<unknown>,
  ) {
    const allowlist = requireQaCommunicationAllowlist();
    const preflight = await this.qaPreflight();
    if (!preflight.safeToRun)
      throw new ForbiddenException('QA_WORKER_PREFLIGHT_BLOCKED');
    await this.db.globalCommunicationDelivery.updateMany({
      where: {
        status: 'SENDING',
        startedAt: { lt: new Date(Date.now() - 300000) },
        outbox: { companyId: { in: allowlist.companyIds } },
      },
      data: { status: 'UNCERTAIN', lastError: 'WORKER_INTERRUPTED', payloadEncrypted: null },
    });
    const temporal = await this.temporal({ companyIds: allowlist.companyIds, limit: 5 });
    const inbox = await ingest({ companyIds: allowlist.companyIds, limit: 5 });
    const progress = { deliveriesCreated: 0 };
    const expanded = await this.expand({
      companyIds: allowlist.companyIds,
      maxEvents: 5,
      qaMode: true,
      progress,
    });
    let processed = 0;
    while (
      processed + progress.deliveriesCreated < 20 &&
      (await this.processOne({ qaMode: true }))
    )
      processed++;
    return {
      mode: 'QA',
      companies: allowlist.companyIds.length,
      temporal,
      inbox,
      expanded,
      processed,
      deliveriesCreated: progress.deliveriesCreated,
      limits: { events: 5, deliveries: 20 },
    };
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
  async temporal(options: { companyIds?: string[]; limit?: number } = {}) {
    if (options.companyIds && !options.companyIds.length) return { inserted: 0 };
    const companyFilter = options.companyIds
      ? Prisma.sql`AND s."companyId" IN (${Prisma.join(options.companyIds)})`
      : Prisma.empty;
    const limit = Math.max(1, Math.min(options.limit ?? 100, 100));
    const now = new Date(),
      horizon = new Date(now.getTime() + 3 * 86400000);
    const inserted = await this.db.$executeRaw`
      INSERT INTO "GlobalCommunicationOutbox" (id, scope, event, "businessKey", "companyId", variables, "createdAt")
      SELECT gen_random_uuid(), 'GLOBAL', 'TRIAL_EXPIRING',
        'TRIAL_EXPIRING:' || s.id::text || ':' || s."trialEndsAt"::text,
        s."companyId", jsonb_build_object('plano',p.name,'dias_trial',ceil(extract(epoch from (s."trialEndsAt" - ${now}::timestamp))/86400)::text,'vencimento',s."trialEndsAt"::text), ${now}
      FROM "Subscription" s JOIN "Plan" p ON p.id=s."planId"
      WHERE s.status='TRIALING' AND s."trialEndsAt">${now} AND s."trialEndsAt"<=${horizon}
      ${companyFilter}
      AND NOT EXISTS (SELECT 1 FROM "GlobalCommunicationOutbox" o WHERE o."businessKey"='TRIAL_EXPIRING:' || s.id::text || ':' || s."trialEndsAt"::text)
      ORDER BY s."trialEndsAt",s.id LIMIT ${limit}
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
