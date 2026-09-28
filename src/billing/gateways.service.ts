import { Inject } from '@nestjs/common';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { boolean, object, string } from '../common/validation.js';
import { GatewayRegistry, gatewayName, gateways } from './gateway.provider.js';
import type { Gateway } from './gateway.provider.js';
import { SecretVault } from './secret-vault.js';
@Injectable()
export class GatewaysService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SecretVault) private readonly vault: SecretVault,
    @Inject(GatewayRegistry) private readonly registry: GatewayRegistry,
  ) {}
  async list() {
    return Promise.all(gateways.map((g) => this.get(g)));
  }
  async get(value: string) {
    const gateway = gatewayName(value);
    const row = await this.prisma.gatewayConfiguration.findUnique({
      where: { gateway },
    });
    return {
      gateway,
      enabled: row?.enabled ?? false,
      environment: row?.environment ?? 'SANDBOX',
      publicId: row?.publicId ?? null,
      configured: !!row?.credentialsEncrypted,
      webhookConfigured:
        gateway === 'PAGBANK'
          ? !!row?.credentialsEncrypted
          : !!row?.webhookSecretEncrypted,
      status: row?.status ?? 'NOT_CONFIGURED',
      lastValidatedAt: row?.lastValidatedAt ?? null,
      provider: gateway,
      adapterAvailable: true,
      capabilities: {
        ...this.registry.get(gateway).capabilities,
        ...(gateway === 'PAGBANK'
          ? { recurring: row?.recurringEnabled ?? false }
          : {}),
      },
      recurringConfigured: !!row?.recurringCredentialsEncrypted,
      webhookStatus:
        gateway === 'PAGBANK'
          ? 'REMOTE_KEY_UNVERIFIED'
          : row?.webhookSecretEncrypted
            ? 'CONFIGURED_UNVERIFIED'
            : 'NOT_CONFIGURED',
      webhookUrl: process.env.BILLING_PUBLIC_API_URL
        ? `${process.env.BILLING_PUBLIC_API_URL.replace(/\/$/, '')}/webhooks/${gateway.toLowerCase().replaceAll('_', '-')}`
        : null,
      webhookPath: `/webhooks/${gateway.toLowerCase().replaceAll('_', '-')}`,
    };
  }
  async update(value: string, input: unknown) {
    const gateway = gatewayName(value);
    const data = object(input, [
      'enabled',
      'environment',
      'publicId',
      'credentials',
      'webhookSecret',
      'recurringCredentials',
      'recurringEnabled',
    ]);
    if (gateway === 'PAGBANK' && data.webhookSecret != null)
      throw new BadRequestException('PAGBANK_WEBHOOK_KEY_MANAGED_BY_PROVIDER');
    boolean(data.enabled, 'enabled');
    boolean(data.recurringEnabled, 'recurringEnabled');
    if (
      gateway !== 'PAGBANK' &&
      (data.recurringCredentials !== undefined ||
        data.recurringEnabled !== undefined)
    )
      throw new BadRequestException('GATEWAY_CAPABILITY_UNAVAILABLE');
    if (
      data.environment !== undefined &&
      !['SANDBOX', 'PRODUCTION'].includes(data.environment as string)
    )
      throw new BadRequestException('Ambiente inválido.');
    if (data.publicId !== undefined && data.publicId !== null)
      string(data.publicId, 'publicId');
    const old = await this.prisma.gatewayConfiguration.findUnique({
      where: { gateway },
    });
    const environment = (data.environment ?? old?.environment ?? 'SANDBOX') as
      'SANDBOX' | 'PRODUCTION';
    if (
      old &&
      environment !== old.environment &&
      (data.credentials === undefined ||
        (gateway !== 'PAGBANK' && data.webhookSecret === undefined) ||
        (gateway === 'PAGBANK' && data.recurringCredentials === undefined))
    )
      throw new BadRequestException(
        'Ao trocar ambiente, substitua ou remova ambas as credenciais.',
      );
    const encrypt = (
      field: 'credentials' | 'webhookSecret' | 'recurringCredentials',
    ) =>
      data[field] === undefined
        ? undefined
        : data[field] === null
          ? null
          : this.vault.encrypt(
              string(data[field], field, 16384),
              `${gateway}:${environment}:${field}`,
            );
    const credentialsEncrypted = encrypt('credentials');
    const webhookSecretEncrypted = encrypt('webhookSecret');
    const recurringCredentialsEncrypted = encrypt('recurringCredentials');
    const changed =
      data.recurringCredentials !== undefined ||
      data.recurringEnabled !== undefined ||
      data.credentials !== undefined ||
      data.webhookSecret !== undefined ||
      environment !== old?.environment;
    if (
      data.recurringEnabled === true &&
      !(recurringCredentialsEncrypted ?? old?.recurringCredentialsEncrypted)
    )
      throw new BadRequestException('PAGBANK_RECURRING_CONFIGURATION_REQUIRED');
    if (gateway === 'ASAAS') {
      const apiKey =
        data.credentials === undefined
          ? old?.credentialsEncrypted
            ? this.vault.decrypt(
                old.credentialsEncrypted,
                `${gateway}:${environment}:credentials`,
              )
            : undefined
          : data.credentials;
      const token =
        data.webhookSecret === undefined
          ? old?.webhookSecretEncrypted
            ? this.vault.decrypt(
                old.webhookSecretEncrypted,
                `${gateway}:${environment}:webhookSecret`,
              )
            : undefined
          : data.webhookSecret;
      if (apiKey && apiKey === token)
        throw new BadRequestException('WEBHOOK_SEPARATE_SECRET_REQUIRED');
    }
    if (
      data.enabled === true &&
      (changed ||
        old?.status !== 'CONNECTED' ||
        !old.credentialsEncrypted ||
        (gateway !== 'PAGBANK' && !old.webhookSecretEncrypted))
    )
      throw new BadRequestException('GATEWAY_VALIDATION_REQUIRED');
    const write = {
      environment,
      enabled: changed ? false : (data.enabled as boolean | undefined),
      publicId: data.publicId as string | null | undefined,
      credentialsEncrypted,
      webhookSecretEncrypted,
      recurringCredentialsEncrypted,
      recurringEnabled: data.recurringEnabled as boolean | undefined,
      lastValidatedAt: changed ? null : undefined,
      status: !changed
        ? undefined
        : (
              credentialsEncrypted === undefined
                ? old?.credentialsEncrypted
                : credentialsEncrypted
            )
          ? ('PENDING_VALIDATION' as const)
          : ('NOT_CONFIGURED' as const),
    };
    if (old) {
      const update = async (
        tx: Pick<PrismaService, 'payment' | 'gatewayConfiguration'>,
      ) => {
        if (
          environment !== old.environment &&
          (await tx.payment.count({
            where: { gateway, environment: old.environment },
          }))
        )
          throw new BadRequestException(
            'GATEWAY_HAS_FINANCIAL_HISTORY_USE_DEDICATED_ENVIRONMENT',
          );
        return tx.gatewayConfiguration.updateMany({
          where: { gateway, updatedAt: old.updatedAt },
          data: write,
        });
      };
      const updated =
        environment !== old.environment
          ? await this.prisma.$transaction(update, {
              isolationLevel: 'Serializable',
            })
          : await update(this.prisma);
      if (!updated.count)
        throw new ConflictException('GATEWAY_CONFIGURATION_CHANGED');
    } else {
      try {
        await this.prisma.gatewayConfiguration.create({
          data: { gateway, ...write },
        });
      } catch {
        throw new ConflictException('GATEWAY_CONFIGURATION_CHANGED');
      }
    }
    return this.get(gateway);
  }
  async context(gateway: Gateway, requireEnabled = true) {
    const config = await this.prisma.gatewayConfiguration.findUnique({
      where: { gateway },
    });
    if (!config?.credentialsEncrypted || (requireEnabled && !config.enabled))
      throw new ServiceUnavailableException('GATEWAY_NOT_ENABLED');
    const scope = `${gateway}:${config.environment}`;
    return {
      configurationVersion: config.updatedAt,
      environment: config.environment,
      credentials: this.vault.decrypt(
        config.credentialsEncrypted,
        `${scope}:credentials`,
      ),
      recurringEnabled: config.recurringEnabled,
      recurringCredentials: config.recurringCredentialsEncrypted
        ? this.vault.decrypt(
            config.recurringCredentialsEncrypted,
            `${scope}:recurringCredentials`,
          )
        : undefined,
      webhookSecret:
        gateway !== 'PAGBANK' && config.webhookSecretEncrypted
          ? this.vault.decrypt(
              config.webhookSecretEncrypted,
              `${scope}:webhookSecret`,
            )
          : undefined,
    };
  }
  async test(value: string) {
    const gateway = gatewayName(value);
    // A missing adapter never records a successful connection.
    const provider = this.registry.get(gateway);
    const snapshot = await this.prisma.gatewayConfiguration.findUnique({
      where: { gateway },
    });
    const context = await this.context(gateway, false);
    try {
      const checks = await provider.test(context);
      const result = await this.prisma.gatewayConfiguration.updateMany({
        where: { gateway, updatedAt: snapshot!.updatedAt },
        data: { status: 'CONNECTED', lastValidatedAt: new Date() },
      });
      if (!result.count)
        throw new BadRequestException('GATEWAY_CONFIGURATION_CHANGED');
      return { gateway, connected: true, ...(checks ? { checks } : {}) };
    } catch {
      await this.prisma.gatewayConfiguration.updateMany({
        where: { gateway, updatedAt: snapshot!.updatedAt },
        data: { status: 'FAILED', lastValidatedAt: new Date(), enabled: false },
      });
      throw new ServiceUnavailableException('GATEWAY_CONNECTION_FAILED');
    }
  }
}
