import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  normalizeSmtp,
  sameSmtp,
  smtpTestData,
  SMTP_PROVIDERS,
} from './smtp-configuration.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SecretVault } from '../billing/secret-vault.js';
import { object, string, boolean } from '../common/validation.js';
import { email, TransportFailure } from './contracts.js';
import type { Message, Variables } from './contracts.js';
import { credentialScope, validateConfig } from './configuration.js';
import { SmtpTransport } from './transports.js';

export type EmailContext =
  { scope: 'SYSTEM' } | { scope: 'COMPANY'; companyId: string };
export const EMAIL_PROVIDERS = SMTP_PROVIDERS;
export function emailInput(input: unknown, previous: Variables = {}) {
  const d = object(input, [
    'provider',
    'email',
    'username',
    'password',
    'smtpHost',
    'smtpPort',
    'security',
    'enabled',
  ]);
  const provider = string(d.provider, 'provider');
  if (!Object.hasOwn(EMAIL_PROVIDERS, provider))
    throw new BadRequestException('EMAIL_PROVIDER_INVALID');
  const address = email(string(d.email, 'email'));
  const security = d.security;
  if (security !== 'TLS' && security !== 'SSL')
    throw new BadRequestException('SMTP_TLS_REQUIRED');
  const host = string(d.smtpHost, 'smtpHost', 253).toLowerCase();
  if (d.smtpPort !== (security === 'SSL' ? 465 : 587))
    throw new BadRequestException('SMTP_TLS_REQUIRED');
  boolean(d.enabled, 'enabled');
  const config = validateConfig('SMTP', {
    host,
    port: String(d.smtpPort),
    secure: String(security === 'SSL'),
    username:
      d.username === undefined ? address : string(d.username, 'username', 320),
    fromEmail: address,
    fromName: previous.fromName ?? 'Kalend',
    ...(previous.replyTo ? { replyTo: previous.replyTo } : {}),
    emailProvider: provider,
  });
  if (
    d.password !== undefined &&
    (typeof d.password !== 'string' ||
      !d.password.trim() ||
      d.password.length > 16384)
  )
    throw new BadRequestException('SECRET_INVALID');
  return {
    config,
    password: d.password as string | undefined,
    enabled: d.enabled as boolean | undefined,
  };
}
@Injectable()
export class EmailService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(SecretVault) private readonly vault: SecretVault,
    @Inject(SmtpTransport) private readonly smtp: SmtpTransport,
  ) {}
  private row(ctx: EmailContext, db = this.db) {
    return ctx.scope === 'SYSTEM'
      ? db.globalCommunicationProvider.findUnique({
          where: { provider: 'SMTP' },
        })
      : db.companyEmailConfiguration.findUnique({
          where: { companyId: ctx.companyId },
        });
  }
  private aad(ctx: EmailContext, environment = 'PRODUCTION') {
    return ctx.scope === 'SYSTEM'
      ? credentialScope('SMTP', environment)
      : `communication:COMPANY:${ctx.companyId}:SMTP:credentials`;
  }
  async get(ctx: EmailContext) {
    const row = await this.row(ctx);
    const c =
      row && Object.keys(row.config as object).length
        ? normalizeSmtp(row.config)
        : ({} as Variables);
    return {
      scope: ctx.scope,
      configured: !!row?.credentialsEncrypted,
      hasPassword: !!row?.credentialsEncrypted,
      provider: c.emailProvider ?? 'CUSTOM',
      email: c.fromEmail ?? '',
      username: c.username ?? '',
      smtpHost: c.host ?? '',
      smtpPort: Number(c.port || 587),
      security: c.secure === 'true' ? 'SSL' : 'TLS',
      enabled: !!row?.enabled && row.lastTestStatus === 'SUCCESS',
      verified: row?.lastTestStatus === 'SUCCESS',
      status: !row?.credentialsEncrypted
        ? 'NOT_CONFIGURED'
        : row.lastTestStatus === 'SUCCESS'
          ? 'VERIFIED'
          : row.lastTestStatus === 'ERROR'
            ? 'ERROR'
            : 'UNTESTED',
      lastTestAt: row?.lastTestStatus ? row.lastVerifiedAt : null,
      lastTestRecipient: row?.lastTestRecipient ?? null,
      lastTestStatus: row?.lastTestStatus ?? null,
    };
  }
  async save(ctx: EmailContext, input: unknown) {
    await this.db.$transaction(
      async (tx) => {
        const old =
          ctx.scope === 'SYSTEM'
            ? await tx.globalCommunicationProvider.findUnique({
                where: { provider: 'SMTP' },
              })
            : await tx.companyEmailConfiguration.findUnique({
                where: { companyId: ctx.companyId },
              });
        const env =
          old && 'environment' in old ? old.environment : 'PRODUCTION';
        const previous =
          old && Object.keys(old.config as object).length
            ? normalizeSmtp(old.config)
            : ({} as Variables);
        const next = emailInput(input, previous);
        const identityChanged = ['host', 'username', 'fromEmail'].some(
          (k) => previous[k] !== next.config[k],
        );
        if (!next.password && (!old?.credentialsEncrypted || identityChanged))
          throw new BadRequestException('EMAIL_PASSWORD_REQUIRED');
        const encrypted = next.password
          ? this.vault.encrypt(
              JSON.stringify({ password: next.password }),
              this.aad(ctx, env),
            )
          : old!.credentialsEncrypted;
        const changed = !!next.password || !sameSmtp(previous, next.config);
        if (next.enabled && (changed || old?.lastTestStatus !== 'SUCCESS'))
          throw new BadRequestException('EMAIL_SEND_TEST_REQUIRED');
        const data = {
          config: next.config,
          credentialsEncrypted: encrypted,
          enabled:
            changed || old?.lastTestStatus !== 'SUCCESS'
              ? false
              : (next.enabled ?? old?.enabled ?? false),
          ...(changed
            ? {
                status: 'PENDING_VALIDATION' as const,
                lastVerifiedAt: null,
                lastTestStatus: null,
                lastTestRecipient: null,
                lastError: null,
              }
            : {}),
        };
        if (ctx.scope === 'SYSTEM')
          await tx.globalCommunicationProvider.upsert({
            where: { provider: 'SMTP' },
            create: { provider: 'SMTP', environment: 'PRODUCTION', ...data },
            update: { ...data, revision: { increment: 1 } },
          });
        else
          await tx.companyEmailConfiguration.upsert({
            where: { companyId: ctx.companyId },
            create: { companyId: ctx.companyId, ...data },
            update: { ...data, revision: { increment: 1 } },
          });
      },
      { isolationLevel: 'Serializable' },
    );
    return this.get(ctx);
  }
  async remove(ctx: EmailContext) {
    const data = {
      enabled: false,
      credentialsEncrypted: null,
      config: {},
      status: 'NOT_CONFIGURED' as const,
      lastTestStatus: null,
      lastVerifiedAt: null,
      lastTestRecipient: null,
      lastError: null,
      revision: { increment: 1 },
    };
    if (ctx.scope === 'SYSTEM')
      await this.db.globalCommunicationProvider.updateMany({
        where: { provider: 'SMTP' },
        data,
      });
    else
      await this.db.companyEmailConfiguration.updateMany({
        where: { companyId: ctx.companyId },
        data,
      });
    return this.get(ctx);
  }
  private async credentials(ctx: EmailContext, requireEnabled: boolean) {
    const row = await this.row(ctx);
    if (
      !row?.credentialsEncrypted ||
      (requireEnabled && (!row.enabled || row.lastTestStatus !== 'SUCCESS'))
    )
      throw new ServiceUnavailableException('EMAIL_NOT_CONFIGURED');
    const config = validateConfig('SMTP', row.config);
    const env = 'environment' in row ? row.environment : 'PRODUCTION';
    const secret = JSON.parse(
      this.vault.decrypt(row.credentialsEncrypted, this.aad(ctx, env)),
    ) as Variables;
    return { row, config, secret };
  }
  // Context is mandatory; a company never falls back to the system sender.
  async send(ctx: EmailContext, message: Message) {
    const { config, secret } = await this.credentials(ctx, true);
    try {
      return await this.smtp.send(config, secret, message);
    } catch {
      throw new ServiceUnavailableException('EMAIL_SEND_FAILED');
    }
  }
  async test(ctx: EmailContext, input: unknown) {
    const d = object(input, ['recipient']);
    const recipient = email(string(d.recipient, 'recipient'));
    const { row, config, secret } = await this.credentials(ctx, false);
    const company =
      ctx.scope === 'COMPANY'
        ? await this.db.company.findUniqueOrThrow({
            where: { id: ctx.companyId },
            select: { name: true },
          })
        : null;
    let sent = false,
      code: string | null = null;
    try {
      await this.smtp.send(config, secret, {
        to: recipient,
        subject: 'Teste de e-mail — Kalend',
        text: `Este é um e-mail de teste enviado pelo Kalend.\n\nA configuração SMTP foi validada com sucesso.\n\n${company ? `Empresa: ${company.name}` : 'Este é um teste da configuração de e-mail do sistema Kalend.'}`,
      });
      sent = true;
    } catch (err) {
      code =
        err instanceof TransportFailure && err.kind === 'AUTH'
          ? 'AUTH_FAILED'
          : 'SEND_FAILED_OR_TIMEOUT';
    }
    const data = smtpTestData(sent, recipient, code);
    const result =
      ctx.scope === 'SYSTEM'
        ? await this.db.globalCommunicationProvider.updateMany({
            where: { provider: 'SMTP', revision: row.revision },
            data,
          })
        : await this.db.companyEmailConfiguration.updateMany({
            where: { companyId: ctx.companyId, revision: row.revision },
            data,
          });
    if (!result.count) throw new ConflictException('CONFIGURATION_CHANGED');
    return {
      sent,
      recipient,
      server: `${config.host}:${config.port}`,
      tls: true,
      code,
      message: sent
        ? 'E-mail enviado com sucesso!'
        : code === 'AUTH_FAILED'
          ? 'Não foi possível enviar o e-mail. Confira o usuário e a senha de app.'
          : 'Não foi possível enviar o e-mail. Confira o servidor e tente novamente.',
      configuration: await this.get(ctx),
    };
  }
}
