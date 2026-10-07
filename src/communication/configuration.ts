import { evolutionPhone } from './evolution-client.js';
import { EvolutionService, GLOBAL_EVOLUTION } from './evolution.js';
import { normalizeSmtp, sameSmtp, smtpTestData } from './smtp-configuration.js';
import { validateVapid } from './push.js';
import { isDeepStrictEqual } from 'node:util';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { SecretVault } from '../billing/secret-vault.js';
import { object, boolean, string } from '../common/validation.js';
import {
  providerName,
  email,
  phone,
  templateContent,
  render,
} from './contracts.js';
import type { Provider, Variables } from './contracts.js';
import { allowedHost } from './network.js';
import { CommunicationTransports } from './transports.js';
const fields: Record<Provider, string[]> = {
  SMTP: [
    'host',
    'port',
    'secure',
    'username',
    'fromName',
    'fromEmail',
    'replyTo',
    'emailProvider',
  ],
  EVOLUTION: ['baseUrl', 'instance', 'version'],
  GMAIL: ['clientId', 'fromEmail'],
  META: ['phoneNumberId', 'businessAccountId', 'graphVersion'],
  PUSH_PENDING: ['subject', 'publicKey'],
};
const secrets: Record<Provider, string[]> = {
  SMTP: ['password'],
  EVOLUTION: [],
  GMAIL: ['clientSecret', 'refreshToken'],
  META: ['accessToken', 'appSecret', 'verifyToken'],
  PUSH_PENDING: ['privateKey'],
};
export function validateConfig(p: Provider, value: unknown): Variables {
  if (p === 'SMTP') {
    const config = normalizeSmtp(value);
    try {
      allowedHost(config.host, 'COMMUNICATION_SMTP_HOSTS');
    } catch {
      throw new BadRequestException('SMTP_HOST_NOT_ALLOWED');
    }
    return config;
  }
  const d = object(value, fields[p]);
  const c: Variables = {};
  for (const [k, v] of Object.entries(d)) c[k] = string(v, k, 500);
  for (const k of fields[p].filter(
    (k) => k !== 'replyTo' && k !== 'emailProvider',
  ))
    if (!c[k])
      throw new BadRequestException('COMMUNICATION_CONFIGURATION_REQUIRED');
  if (p === 'GMAIL') {
    email(c.fromEmail);
    if (!/^[a-zA-Z0-9.-]+\.apps\.googleusercontent\.com$/.test(c.clientId))
      throw new BadRequestException('GMAIL_CLIENT_ID_INVALID');
  }
  if (p === 'PUSH_PENDING') validateVapid(c);
  if (
    p === 'META' &&
    (!/^\d+$/.test(c.phoneNumberId + c.businessAccountId) ||
      !/^v\d+\.0$/.test(c.graphVersion) ||
      c.graphVersion !== process.env.COMMUNICATION_META_GRAPH_VERSION)
  )
    throw new BadRequestException('META_CONFIG_INVALID');
  if (p === 'EVOLUTION') {
    let u: URL;
    try {
      u = new URL(c.baseUrl);
    } catch {
      throw new BadRequestException('EVOLUTION_URL_INVALID');
    }
    if (
      u.protocol !== 'https:' ||
      u.username ||
      u.password ||
      u.port ||
      u.search ||
      u.hash ||
      u.pathname !== '/'
    )
      throw new BadRequestException('EVOLUTION_URL_INVALID');
    if (u.hostname !== 'evolution-api.kalend.tech')
      throw new BadRequestException('EVOLUTION_URL_INVALID');
    if (
      !/^[a-zA-Z0-9_-]{1,100}$/.test(c.instance) ||
      /^kalend_[a-f0-9]{32}$/i.test(c.instance) ||
      c.version !== '2.3.7'
    )
      throw new BadRequestException('EVOLUTION_VERSION_OR_INSTANCE_INVALID');
  }
  return c;
}
export function mergeSecrets(
  p: Provider,
  old: Variables,
  value: unknown,
): Variables {
  if (value === undefined) return old;
  const d = object(value, secrets[p]);
  const result = { ...old };
  for (const [k, v] of Object.entries(d)) {
    if (v === '') continue;
    if (v === null) delete result[k];
    else {
      if (typeof v !== 'string' || v.length > 16384 || !v.trim())
        throw new BadRequestException('SECRET_INVALID');
      result[k] = v;
    }
  }
  return result;
}
export const credentialScope = (p: Provider, e: string) =>
  `communication:GLOBAL:${p}:${e}:credentials`;
@Injectable()
export class CommunicationConfiguration {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(SecretVault) private readonly vault: SecretVault,
    @Inject(CommunicationTransports)
    private readonly transports: CommunicationTransports,
    @Inject(EvolutionService) private readonly evolution?: EvolutionService,
  ) {}
  // Resolution uses only GLOBAL rows. Template provider is retained for legacy storage.
  async resolveProvider(
    channel: 'EMAIL' | 'WHATSAPP' | 'PUSH',
    db: Pick<PrismaService, 'globalCommunicationProvider'> = this.db,
    requireActive = true,
  ): Promise<Provider | null> {
    const candidates: Provider[] =
      channel === 'EMAIL'
        ? ['SMTP', 'GMAIL']
        : channel === 'WHATSAPP'
          ? ['EVOLUTION']
          : ['PUSH_PENDING'];
    for (const provider of candidates) {
      const row = await db.globalCommunicationProvider.findUnique({
        where: { provider },
      });
      if (
        row?.scope === 'GLOBAL' &&
        row.enabled &&
        this.transports.available(provider) &&
        (provider !== 'SMTP' || row.lastTestStatus === 'SUCCESS')
      )
        return provider;
    }
    return requireActive ? null : candidates[0];
  }
  async list() {
    const rows = await this.db.globalCommunicationProvider.findMany({
      where: { scope: 'GLOBAL' },
    });
    const global = rows.some((row) => row.provider === 'EVOLUTION')
      ? await this.db.evolutionConnection.findUnique({
          where: { globalKey: 'GLOBAL' },
        })
      : null;
    return rows.map((r) => ({
      provider: r.provider,
      scope: r.scope,
      environment: r.provider === 'EVOLUTION' ? 'PRODUCTION' : r.environment,
      enabled:
        r.provider === 'SMTP'
          ? r.enabled && r.lastTestStatus === 'SUCCESS'
          : r.enabled,
      config: r.provider === 'EVOLUTION' ? {} : r.config,
      configured:
        r.provider === 'EVOLUTION'
          ? !!process.env.EVOLUTION_API_KEY && !!global?.prepared
          : !!r.credentialsEncrypted,
      status:
        r.provider === 'SMTP' && r.credentialsEncrypted
          ? r.lastTestStatus === 'SUCCESS'
            ? 'CONNECTED'
            : r.lastTestStatus === 'ERROR'
              ? 'FAILED'
              : 'PENDING_VALIDATION'
          : r.provider === 'EVOLUTION'
            ? global?.status === 'CONNECTED'
              ? 'CONNECTED'
              : global?.status === 'ERROR'
                ? 'FAILED'
                : 'PENDING_VALIDATION'
            : r.status,
      revision: r.revision,
      lastVerifiedAt:
        r.provider === 'SMTP' && !r.lastTestStatus ? null : r.lastVerifiedAt,
      lastSentAt: r.lastSentAt,
      lastError: r.lastError,
      adapterAvailable: this.transports.available(r.provider),
    }));
  }
  async patch(name: string, input: unknown, actorId: string) {
    const p = providerName(name),
      d = object(input, ['config', 'secrets', 'environment', 'enabled']);
    if (
      p === 'EVOLUTION' &&
      (d.config !== undefined ||
        d.secrets !== undefined ||
        d.environment !== undefined)
    )
      throw new BadRequestException('EVOLUTION_MANAGED_BY_BACKEND');
    boolean(d.enabled, 'enabled');
    if (p === 'EVOLUTION') {
      if (!this.evolution)
        throw new ServiceUnavailableException('EVOLUTION_UNAVAILABLE');
      const connection =
        d.enabled === true
          ? await this.evolution.get(GLOBAL_EVOLUTION)
          : await this.evolution.globalConnection();
      if (d.enabled === true && connection.status !== 'CONNECTED')
        throw new BadRequestException({
          errorCode: 'CONNECTION_NOT_OPEN',
          message:
            'WhatsApp não conectado. Atualize a conexão antes de habilitar o envio.',
        });
      await this.db.globalCommunicationProvider.update({
        where: { provider: 'EVOLUTION' },
        data: {
          enabled: d.enabled as boolean | undefined,
          environment: 'PRODUCTION',
          revision: { increment: 1 },
        },
      });
      await this.db.globalCommunicationLog.create({
        data: { actorId, action: 'PROVIDER_UPDATE_EVOLUTION' },
      });
      return (await this.list()).find((row) => row.provider === 'EVOLUTION');
    }

    if (
      d.environment !== undefined &&
      (typeof d.environment !== 'string' ||
        !['SANDBOX', 'PRODUCTION'].includes(d.environment))
    )
      throw new BadRequestException('ENVIRONMENT_INVALID');
    await this.db.$transaction(
      async (tx) => {
        const old = await tx.globalCommunicationProvider.findUnique({
          where: { provider: p },
        });
        const environment = (d.environment ?? old?.environment ?? 'SANDBOX') as
          'SANDBOX' | 'PRODUCTION';
        const changedEnvironment = !!old && old.environment !== environment;
        if (
          changedEnvironment &&
          (await tx.globalCommunicationDelivery.count({
            where: { provider: p },
          }))
        )
          throw new ConflictException('ENVIRONMENT_HAS_HISTORY');
        const previous =
          old?.credentialsEncrypted && !changedEnvironment
            ? (JSON.parse(
                this.vault.decrypt(
                  old.credentialsEncrypted,
                  credentialScope(p, environment),
                ),
              ) as Variables)
            : {};
        // OAuth tokens are accepted only from Google's callback, never from administrative input.
        if (p === 'GMAIL' && d.secrets !== undefined)
          object(d.secrets, ['clientSecret']);
        const next = mergeSecrets(p, previous, d.secrets);
        if (
          changedEnvironment &&
          !secrets[p]
            .filter((k) => p !== 'GMAIL' || k === 'clientSecret')
            .every((k) => !!next[k])
        )
          throw new BadRequestException('ENVIRONMENT_REQUIRES_NEW_SECRETS');
        const oldConfig =
          p === 'SMTP' && old && Object.keys(old.config as object).length
            ? normalizeSmtp(old.config)
            : old?.config;
        const config = validateConfig(
          p,
          p === 'SMTP' && d.config !== undefined
            ? {
                ...(oldConfig as Variables),
                ...object(d.config, fields.SMTP),
              }
            : (d.config ?? oldConfig ?? {}),
        );
        const identityKeys =
          p === 'META' ? ['businessAccountId', 'phoneNumberId'] : [];
        if (
          old &&
          identityKeys.some(
            (k) => (old.config as Variables)[k] !== config[k],
          ) &&
          (await tx.globalCommunicationDelivery.count({
            where: { provider: p },
          }))
        )
          throw new ConflictException('PROVIDER_ACCOUNT_HAS_HISTORY');
        if (
          p === 'GMAIL' &&
          (!isDeepStrictEqual(config, old?.config) ||
            next.clientSecret !== previous.clientSecret ||
            changedEnvironment)
        ) {
          for (const key of Object.keys(next))
            if (key !== 'clientSecret') delete next[key];
        }
        if (p === 'PUSH_PENDING' && next.privateKey)
          validateVapid(config, next);
        const changed =
          !old ||
          changedEnvironment ||
          !(p === 'SMTP'
            ? sameSmtp(config, oldConfig as Variables)
            : isDeepStrictEqual(config, old.config)) ||
          !isDeepStrictEqual(next, previous);
        if (
          d.enabled === true &&
          (changed ||
            old?.status !== 'CONNECTED' ||
            (p === 'SMTP' && old?.lastTestStatus !== 'SUCCESS') ||
            !this.transports.available(p))
        )
          throw new BadRequestException('CONNECTION_TEST_REQUIRED');
        const encrypted = Object.keys(next).length
          ? this.vault.encrypt(
              JSON.stringify(next),
              credentialScope(p, environment),
            )
          : null;
        const data = {
          environment,
          config,
          credentialsEncrypted: encrypted,
          enabled:
            changed || (p === 'SMTP' && old?.lastTestStatus !== 'SUCCESS')
              ? false
              : (d.enabled as boolean | undefined),
          status: changed
            ? encrypted
              ? ('PENDING_VALIDATION' as const)
              : ('NOT_CONFIGURED' as const)
            : undefined,
          lastVerifiedAt: changed ? null : undefined,
          lastTestStatus: changed ? null : undefined,
          lastTestRecipient: changed ? null : undefined,
          lastSentAt: changed ? null : undefined,
          lastError: null,
        };
        if (old) {
          const r = await tx.globalCommunicationProvider.updateMany({
            where: { provider: p, revision: old.revision },
            data: { ...data, revision: { increment: 1 } },
          });
          if (!r.count) throw new ConflictException('CONFIGURATION_CHANGED');
        } else
          await tx.globalCommunicationProvider.create({
            data: { provider: p, ...data },
          });
        if (d.enabled === true && (p === 'SMTP' || p === 'GMAIL'))
          await tx.globalCommunicationProvider.updateMany({
            where: {
              scope: 'GLOBAL',
              provider: p === 'SMTP' ? 'GMAIL' : 'SMTP',
              enabled: true,
            },
            data: { enabled: false, revision: { increment: 1 } },
          });
        await tx.globalCommunicationLog.create({
          data: { actorId, action: `PROVIDER_UPDATE_${p}` },
        });
      },
      { isolationLevel: 'Serializable' },
    );
    return (await this.list()).find((r) => r.provider === p);
  }
  async context(p: Provider, requireEnabled = true) {
    const row = await this.db.globalCommunicationProvider.findUnique({
      where: { provider: p },
    });
    if (
      !row ||
      (p === 'EVOLUTION'
        ? !process.env.EVOLUTION_API_KEY
        : !row.credentialsEncrypted) ||
      row.scope !== 'GLOBAL' ||
      (requireEnabled &&
        (!row.enabled || (p === 'SMTP' && row.lastTestStatus !== 'SUCCESS'))) ||
      !this.transports.available(p)
    )
      throw new ServiceUnavailableException(
        'COMMUNICATION_PROVIDER_UNAVAILABLE',
      );
    const connection =
      p === 'EVOLUTION' ? await this.evolution?.globalConnection() : null;
    if (
      p === 'EVOLUTION' &&
      (!connection?.prepared ||
        (requireEnabled && connection.status !== 'CONNECTED'))
    )
      throw new ServiceUnavailableException(
        'COMMUNICATION_PROVIDER_UNAVAILABLE',
      );
    const config =
      p === 'EVOLUTION'
        ? {
            instance: connection!.instanceName,
            baseUrl: 'https://evolution-api.kalend.tech',
            version: '2.3.7',
          }
        : validateConfig(p, row.config);
    const secret =
      p === 'EVOLUTION'
        ? {}
        : (JSON.parse(
            this.vault.decrypt(
              row.credentialsEncrypted!,
              credentialScope(p, row.environment),
            ),
          ) as Variables);
    if (
      !secrets[p]
        .filter((k) => p !== 'META' || k === 'accessToken')
        .every((k) => secret[k])
    )
      throw new ServiceUnavailableException('COMMUNICATION_SECRETS_REQUIRED');
    return { row, config, secret };
  }
  async pairEvolution(actorId: string) {
    if (!this.evolution)
      throw new ServiceUnavailableException('EVOLUTION_UNAVAILABLE');
    await this.db.globalCommunicationLog.create({
      data: { actorId, action: 'EVOLUTION_PAIRING_REQUESTED' },
    });
    // Legacy route, same session DTO as the native Evolution endpoints. Waiting is not a 503.
    return this.evolution.prepare(GLOBAL_EVOLUTION);
  }
  async sendTest(name: string, input: unknown, actorId: string) {
    const p = providerName(name),
      d = object(
        input,
        p === 'META' ? ['template'] : p === 'EVOLUTION' ? ['number'] : [],
      );
    const actor = await this.db.user.findFirst({
      where: { id: actorId, isSuperAdmin: true, isActive: true },
      select: { email: true, phone: true },
    });
    if (!actor) throw new BadRequestException('TEST_RECIPIENT_UNAUTHORIZED');
    if (p === 'EVOLUTION') {
      const row = await this.db.globalCommunicationProvider.findUnique({
        where: { provider: p },
      });
      if (!row?.enabled || row.scope !== 'GLOBAL')
        throw new BadRequestException({
          errorCode: 'GLOBAL_PROVIDER_DISABLED',
          message:
            'O uso do WhatsApp para comunicação está desabilitado. Habilite o envio antes do teste.',
        });
      if (
        !this.evolution ||
        (await this.evolution.get(GLOBAL_EVOLUTION)).status !== 'CONNECTED'
      )
        throw new BadRequestException({
          errorCode: 'CONNECTION_NOT_OPEN',
          message: 'WhatsApp não conectado ou sessão fechada.',
        });
    }
    const ctx = await this.context(p, false);
    if (p === 'EVOLUTION') {
      try {
        evolutionPhone(d.number ?? actor.phone);
      } catch {
        throw new BadRequestException({
          errorCode: 'TEST_RECIPIENT_UNAVAILABLE',
          message:
            'Informe um telefone válido com DDI no seu perfil para receber a mensagem de teste.',
        });
      }
    }
    const devices =
      p === 'PUSH_PENDING'
        ? await this.db.globalPushSubscription.findMany({
            where: {
              userId: actorId,
              environment: ctx.row.environment,
              scope: 'GLOBAL',
              active: true,
              provider: 'WEB_PUSH',
              revokedAt: null,
              OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
            },
            select: { id: true },
            take: 20,
          })
        : [];
    if (p === 'PUSH_PENDING' && !devices.length)
      throw new BadRequestException('PUSH_NO_DEVICE');
    const to =
      p === 'PUSH_PENDING'
        ? devices[0].id
        : p === 'SMTP' || p === 'GMAIL'
          ? email(actor.email)
          : p === 'EVOLUTION'
            ? evolutionPhone(d.number ?? actor.phone)
            : phone(actor.phone);
    const message =
      p === 'META'
        ? render(
            templateContent(d.template, 'WHATSAPP', 'OWNER_WELCOME', 'META'),
            'WHATSAPP',
            'OWNER_WELCOME',
            {},
            to,
          )
        : {
            to,
            subject: 'Teste de comunicação Kalend',
            title: 'Kalend',
            text:
              p === 'EVOLUTION'
                ? '✅ Teste de WhatsApp do Kalend realizado com sucesso.'
                : 'Teste do canal global Kalend.',
          };
    // Test recipient is the authenticated administrator, never a supplied address.
    await this.db.globalCommunicationLog.create({
      data: { actorId, action: `SEND_TEST_STARTED_${p}` },
    });
    try {
      if (p === 'PUSH_PENDING') {
        for (const device of devices)
          await this.transports.get(p).send(ctx.config, ctx.secret, {
            ...message,
            to: device.id,
            pushRecipient: {
              userId: actorId,
              environment: ctx.row.environment,
              audience: 'ADMIN_TEST',
            },
          });
      } else
        await this.transports
          .get(p)
          .send(
            ctx.config,
            ctx.secret,
            p === 'EVOLUTION'
              ? {
                  ...message,
                  globalRecipientUserId: actorId,
                  ...(d.number !== undefined
                    ? { globalTestNumber: evolutionPhone(d.number) }
                    : {}),
                }
              : message,
          );
      await this.db.$transaction(async (tx) => {
        const updated = await tx.globalCommunicationProvider.updateMany({
          where: { provider: p, revision: ctx.row.revision },
          data: {
            lastSentAt: new Date(),
            ...(p === 'SMTP' ? smtpTestData(true, to, null) : {}),
          },
        });
        if (p === 'SMTP' && !updated.count)
          throw new ConflictException('CONFIGURATION_CHANGED');
        await tx.globalCommunicationLog.create({
          data: { actorId, action: `SEND_TEST_ACCEPTED_${p}` },
        });
      });
      return { accepted: true, delivered: false };
    } catch (error) {
      if (p === 'EVOLUTION') {
        const code =
          error instanceof Error &&
          'code' in error &&
          typeof error.code === 'string'
            ? error.code
            : 'SEND_TEST_FAILED_OR_UNCERTAIN';
        const messages: Record<string, string> = {
          CONNECTION_NOT_OPEN:
            'A sessão WhatsApp está fechada. Reconecte antes de enviar.',
          INVALID_PHONE: 'O telefone do destinatário é inválido.',
          GLOBAL_RECIPIENT_UNAVAILABLE:
            'Configure um telefone válido no perfil do administrador.',
          EVOLUTION_UNAVAILABLE:
            'A Evolution está indisponível. Tente novamente mais tarde.',
          EVOLUTION_TIMEOUT: 'A Evolution não respondeu no prazo.',
          EVOLUTION_AUTH_FAILED: 'A autenticação da Evolution é inválida.',
          EVOLUTION_FORBIDDEN:
            'A Evolution recusou o acesso à instância global.',
          EVOLUTION_RATE_LIMITED:
            'A Evolution limitou os envios. Aguarde antes de repetir.',
          EVOLUTION_INVALID_RESPONSE:
            'A Evolution retornou uma resposta inválida.',
          INTEGRATION_STATE_UNAVAILABLE:
            'Não foi possível verificar o estado da conexão WhatsApp.',
          MESSAGE_ACCEPTANCE_UNKNOWN:
            'Não foi possível confirmar o envio. Verifique o destinatário antes de repetir.',
          INTEGRATION_BUSY:
            'A conexão está ocupada. Aguarde e tente novamente.',
        };
        await this.db.globalCommunicationLog.create({
          data: {
            actorId,
            action: 'SEND_TEST_FAILED_OR_UNCERTAIN_EVOLUTION',
            code: Object.hasOwn(messages, code)
              ? code
              : 'SEND_TEST_FAILED_OR_UNCERTAIN',
          },
        });
        throw new ServiceUnavailableException({
          errorCode: Object.hasOwn(messages, code)
            ? code
            : 'SEND_TEST_FAILED_OR_UNCERTAIN',
          message:
            messages[code] ??
            'Erro de envio WhatsApp. Não foi possível confirmar a aceitação da mensagem.',
        });
      }
      if (p === 'SMTP')
        await this.db.globalCommunicationProvider.updateMany({
          where: { provider: p, revision: ctx.row.revision },
          data: smtpTestData(false, to, 'SEND_FAILED_OR_TIMEOUT'),
        });
      await this.db.globalCommunicationLog.create({
        data: { actorId, action: `SEND_TEST_FAILED_OR_UNCERTAIN_${p}` },
      });
      throw new ServiceUnavailableException('SEND_TEST_FAILED_OR_UNCERTAIN');
    }
  }
  async test(name: string, actorId: string) {
    const p = providerName(name),
      c = await this.context(p, false);
    let ok = false;
    try {
      await this.transports.get(p).verify(c.config, c.secret);
      ok = true;
    } catch {
      /* no provider exception is persisted */
    }
    if (p === 'SMTP') {
      await this.db.globalCommunicationLog.create({
        data: {
          actorId,
          action: 'SMTP_CONNECTION_CHECK',
          code: ok ? 'CONNECTION_OK' : 'CONNECTION_FAILED',
        },
      });
      return { connected: ok, sendTested: false };
    }
    await this.db.$transaction(async (tx) => {
      const r = await tx.globalCommunicationProvider.updateMany({
        where: { provider: p, revision: c.row.revision },
        data: {
          status: ok ? 'CONNECTED' : 'FAILED',
          lastVerifiedAt: new Date(),
          lastError: ok ? null : 'CONNECTION_FAILED',
          ...(!ok ? { enabled: false } : {}),
        },
      });
      if (!r.count) throw new ConflictException('CONFIGURATION_CHANGED');
      await tx.globalCommunicationLog.create({
        data: {
          actorId,
          action: `PROVIDER_TEST_${p}`,
          code: ok ? 'CONNECTED' : 'CONNECTION_FAILED',
        },
      });
    });
    return { connected: ok, sendTested: false };
  }
}
