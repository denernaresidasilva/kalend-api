import { Inject } from '@nestjs/common';
import {
  BadRequestException,
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
      webhookConfigured: !!row?.webhookSecretEncrypted,
      status: row?.status ?? 'NOT_CONFIGURED',
      lastValidatedAt: row?.lastValidatedAt ?? null,
      adapterAvailable: false,
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
    ]);
    boolean(data.enabled, 'enabled');
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
      (data.credentials === undefined || data.webhookSecret === undefined)
    )
      throw new BadRequestException(
        'Ao trocar ambiente, substitua ou remova ambas as credenciais.',
      );
    const encrypt = (field: 'credentials' | 'webhookSecret') =>
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
    if (data.enabled === true)
      throw new ServiceUnavailableException('GATEWAY_ADAPTER_PENDING');
    await this.prisma.gatewayConfiguration.upsert({
      where: { gateway },
      create: {
        gateway,
        environment,
        publicId: data.publicId as string | null | undefined,
        credentialsEncrypted,
        webhookSecretEncrypted,
        status: credentialsEncrypted ? 'PENDING_VALIDATION' : 'NOT_CONFIGURED',
      },
      update: {
        environment,
        enabled: false,
        publicId: data.publicId as string | null | undefined,
        credentialsEncrypted,
        webhookSecretEncrypted,
        lastValidatedAt: null,
        status: (
          credentialsEncrypted === undefined
            ? old?.credentialsEncrypted
            : credentialsEncrypted
        )
          ? 'PENDING_VALIDATION'
          : 'NOT_CONFIGURED',
      },
    });
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
      environment: config.environment,
      credentials: this.vault.decrypt(
        config.credentialsEncrypted,
        `${scope}:credentials`,
      ),
      webhookSecret: config.webhookSecretEncrypted
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
    const context = await this.context(gateway, false);
    try {
      await provider.test(context);
      await this.prisma.gatewayConfiguration.update({
        where: { gateway },
        data: { status: 'CONNECTED', lastValidatedAt: new Date() },
      });
      return { gateway, connected: true };
    } catch {
      await this.prisma.gatewayConfiguration.update({
        where: { gateway },
        data: { status: 'FAILED', lastValidatedAt: new Date(), enabled: false },
      });
      throw new ServiceUnavailableException('GATEWAY_CONNECTION_FAILED');
    }
  }
}
