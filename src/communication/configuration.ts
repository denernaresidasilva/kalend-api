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
import { EvolutionTransport, CommunicationTransports } from './transports.js';
const fields: Record<Provider, string[]> = {
  SMTP: [
    'host',
    'port',
    'secure',
    'username',
    'fromName',
    'fromEmail',
    'replyTo',
  ],
  EVOLUTION: ['baseUrl', 'instance', 'version'],
  GMAIL: ['clientId', 'fromEmail'],
  META: ['phoneNumberId', 'businessAccountId', 'graphVersion'],
  PUSH_PENDING: [],
};
const secrets: Record<Provider, string[]> = {
  SMTP: ['password'],
  EVOLUTION: ['apiKey'],
  GMAIL: ['clientSecret', 'refreshToken'],
  META: ['accessToken', 'appSecret', 'verifyToken'],
  PUSH_PENDING: [],
};
export function validateConfig(p: Provider, value: unknown): Variables {
  const d = object(value, fields[p]);
  const c: Variables = {};
  for (const [k, v] of Object.entries(d)) c[k] = string(v, k, 500);
  for (const k of fields[p].filter((k) => k !== 'replyTo'))
    if (!c[k])
      throw new BadRequestException('COMMUNICATION_CONFIGURATION_REQUIRED');
  if (p === 'SMTP') {
    allowedHost(c.host, 'COMMUNICATION_SMTP_HOSTS');
    if (!(
      (c.port === '465' && c.secure === 'true') ||
      (c.port === '587' && c.secure === 'false')
    ))
      throw new BadRequestException('SMTP_TLS_REQUIRED');
    email(c.fromEmail);
    if (c.replyTo) email(c.replyTo);
    if (/[\r\n]/.test(c.fromName + c.username))
      throw new BadRequestException('HEADER_INVALID');
    if (c.host === 'smtp.gmail.com')
      throw new BadRequestException('GMAIL_OAUTH_REQUIRED');
  }
  if (p === 'GMAIL') email(c.fromEmail);
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
    allowedHost(u.hostname, 'COMMUNICATION_EVOLUTION_HOSTS');
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(c.instance) || c.version !== '2.3.7')
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
  ) {}
  async list() {
    const rows = await this.db.globalCommunicationProvider.findMany();
    return rows.map((r) => ({
      provider: r.provider,
      scope: r.scope,
      environment: r.environment,
      enabled: r.enabled,
      config: r.config,
      configured: !!r.credentialsEncrypted,
      status: r.status,
      revision: r.revision,
      lastVerifiedAt: r.lastVerifiedAt,
      lastSentAt: r.lastSentAt,
      lastError: r.lastError,
      adapterAvailable: this.transports.available(r.provider),
    }));
  }
  async patch(name: string, input: unknown, actorId: string) {
    const p = providerName(name),
      d = object(input, ['config', 'secrets', 'environment', 'enabled']);
    boolean(d.enabled, 'enabled');
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
        const next = mergeSecrets(p, previous, d.secrets);
        if (changedEnvironment && !secrets[p].every((k) => !!next[k]))
          throw new BadRequestException('ENVIRONMENT_REQUIRES_NEW_SECRETS');
        const config = validateConfig(p, d.config ?? old?.config ?? {});
        const identityKeys =
          p === 'META'
            ? ['businessAccountId', 'phoneNumberId']
            : p === 'EVOLUTION'
              ? ['baseUrl', 'instance']
              : [];
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
        const changed =
          !old ||
          changedEnvironment ||
          !isDeepStrictEqual(config, old.config) ||
          !isDeepStrictEqual(next, previous);
        if (
          d.enabled === true &&
          (changed ||
            old?.status !== 'CONNECTED' ||
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
          enabled: changed ? false : (d.enabled as boolean | undefined),
          status: changed
            ? encrypted
              ? ('PENDING_VALIDATION' as const)
              : ('NOT_CONFIGURED' as const)
            : undefined,
          lastVerifiedAt: changed ? null : undefined,
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
      !row?.credentialsEncrypted ||
      (requireEnabled && !row.enabled) ||
      !this.transports.available(p)
    )
      throw new ServiceUnavailableException(
        'COMMUNICATION_PROVIDER_UNAVAILABLE',
      );
    const config = validateConfig(p, row.config);
    const secret = JSON.parse(
      this.vault.decrypt(
        row.credentialsEncrypted,
        credentialScope(p, row.environment),
      ),
    ) as Variables;
    if (
      !secrets[p]
        .filter((k) => p !== 'META' || k === 'accessToken')
        .every((k) => secret[k])
    )
      throw new ServiceUnavailableException('COMMUNICATION_SECRETS_REQUIRED');
    return { row, config, secret };
  }
  async pairEvolution(actorId: string) {
    const ctx = await this.context('EVOLUTION', false);
    await this.db.globalCommunicationLog.create({
      data: { actorId, action: 'EVOLUTION_PAIRING_REQUESTED' },
    });
    try {
      return await new EvolutionTransport().pair(ctx.config, ctx.secret);
    } catch {
      throw new ServiceUnavailableException('EVOLUTION_PAIRING_UNAVAILABLE');
    }
  }
  async sendTest(name: string, input: unknown, actorId: string) {
    const p = providerName(name),
      d = object(input, p === 'META' ? ['template'] : []);
    const actor = await this.db.user.findFirst({
      where: { id: actorId, isSuperAdmin: true, isActive: true },
      select: { email: true, phone: true },
    });
    if (!actor) throw new BadRequestException('TEST_RECIPIENT_UNAUTHORIZED');
    const ctx = await this.context(p, false);
    const to =
      p === 'SMTP' || p === 'GMAIL' ? email(actor.email) : phone(actor.phone);
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
            text: 'Teste do canal global Kalend.',
          };
    // Test recipient is the authenticated administrator, never a supplied address.
    await this.db.globalCommunicationLog.create({
      data: { actorId, action: `SEND_TEST_STARTED_${p}` },
    });
    try {
      await this.transports.get(p).send(ctx.config, ctx.secret, message);
      await this.db.$transaction(async (tx) => {
        await tx.globalCommunicationProvider.updateMany({
          where: { provider: p, revision: ctx.row.revision },
          data: { lastSentAt: new Date() },
        });
        await tx.globalCommunicationLog.create({
          data: { actorId, action: `SEND_TEST_ACCEPTED_${p}` },
        });
      });
      return { accepted: true, delivered: false };
    } catch {
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
