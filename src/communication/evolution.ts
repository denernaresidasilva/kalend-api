import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import type {
  EvolutionConnection,
  EvolutionConnectionStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { SecretVault } from '../billing/secret-vault.js';
import { uuid } from '../common/validation.js';
import {
  evolutionConfiguration,
  evolutionInstanceName,
  evolutionGlobalName,
  safeProductionGlobalName,
} from './evolution-environment.js';
export { evolutionInstanceName } from './evolution-environment.js';
import {
  EvolutionClient,
  EvolutionFailure,
  evolutionPhone,
  evolutionQr,
  record,
} from './evolution-client.js';

export type EvolutionContext = string | { scope: 'GLOBAL' };
export const GLOBAL_EVOLUTION = { scope: 'GLOBAL' } as const;
export const GLOBAL_INSTANCE_NAME = 'kalend_global';
export function evolutionStatus(state: unknown): EvolutionConnectionStatus {
  return state === 'open'
    ? 'CONNECTED'
    : state === 'connecting'
      ? 'CONNECTING'
      : state === 'close'
        ? 'DISCONNECTED'
        : state === 'refused'
          ? 'ERROR'
          : 'PENDING';
}
type Snapshot = EvolutionConnection & { temporaryCode?: Code };
type Code = {
  qrCode: string | null;
  pairingCode: string | null;
  expiresAt: number;
  mode: 'qr' | 'phone';
};
const messages: Record<string, string> = {
  EVOLUTION_AUTH_FAILED:
    'A integração precisa ser verificada pela administração.',
  EVOLUTION_UNAVAILABLE:
    'O WhatsApp está temporariamente indisponível. Tente novamente em instantes.',
  EVOLUTION_WEBHOOK_BASE_URL_REQUIRED:
    'EVOLUTION_WEBHOOK_BASE_URL é obrigatória para configurar a integração.',
  EVOLUTION_WEBHOOK_BASE_URL_INVALID:
    'A URL pública do webhook precisa ser verificada pela administração.',
  EVOLUTION_ENVIRONMENT_MISMATCH:
    'O ambiente da integração não corresponde ao ambiente desta API.',
  WEBHOOK_NOT_CONFIGURED:
    'A integração precisa ser configurada pela administração.',
  QR_UNAVAILABLE: 'Aguarde enquanto o WhatsApp gera o QR Code.',
  PAIRING_CODE_UNAVAILABLE:
    'O código ainda não está disponível. Aguarde ou conecte usando QR Code.',
};
@Injectable()
export class EvolutionService {
  private readonly logger = new Logger('EVOLUTION');
  // Payloads exist only in the current response. Replicas share expiry/recovery metadata, never QR/codes.
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(EvolutionClient) private readonly client: EvolutionClient,
    @Inject(SecretVault) private readonly vault: SecretVault,
  ) {}

  private configuration() {
    try {
      return evolutionConfiguration();
    } catch (error) {
      const code =
        error instanceof EvolutionFailure
          ? error.code
          : 'EVOLUTION_WEBHOOK_BASE_URL_INVALID';
      throw new ServiceUnavailableException({
        errorCode: code,
        message: messages[code],
      });
    }
  }
  private async ensure(context: EvolutionContext) {
    const { environment } = this.configuration();
    let row: EvolutionConnection;
    if (typeof context !== 'string') {
      const legacy =
        environment === 'PRODUCTION'
          ? await this.db.globalCommunicationProvider.findUnique({
              where: { provider: 'EVOLUTION' },
            })
          : null;
      const name = record(legacy?.config).instance;
      const instanceName =
        environment === 'PRODUCTION' && safeProductionGlobalName(name)
          ? name
          : evolutionGlobalName(environment);
      row = await this.db.evolutionConnection.upsert({
        where: { globalKey: 'GLOBAL' },
        update: {},
        create: { globalKey: 'GLOBAL', environment, instanceName },
      });
    } else {
      const companyId = uuid(context);
      row = await this.db.evolutionConnection.upsert({
        where: { companyId },
        update: {},
        create: {
          companyId,
          environment,
          instanceName: evolutionInstanceName(companyId, environment),
        },
      });
    }
    if (row.environment != null && row.environment !== environment)
      throw new ServiceUnavailableException('EVOLUTION_ENVIRONMENT_MISMATCH');
    return row;
  }
  private async bindEnvironment(row: EvolutionConnection, leaseId: string) {
    const { environment } = this.configuration();
    if (row.environment != null && row.environment !== environment)
      throw new ServiceUnavailableException('EVOLUTION_ENVIRONMENT_MISMATCH');
    if (row.environment == null) {
      const name = row.companyId
        ? evolutionInstanceName(row.companyId, environment)
        : environment === 'PRODUCTION' &&
            safeProductionGlobalName(row.instanceName)
          ? row.instanceName
          : evolutionGlobalName(environment);
      const changed = name !== row.instanceName;
      Object.assign(
        row,
        await this.write(row.id, leaseId, {
          environment,
          instanceName: name,
          prepared: false,
          status: 'PENDING',
          connectionRequested: false,
          webhookSecretEncrypted: null,
          lastWebhookAt: null,
          codeFingerprint: null,
          codeExpiresAt: null,
          lastRecoveryAt: null,
          ...(changed
            ? {
                phone: null,
                profileName: null,
                connectedAt: null,
                disconnectedAt: null,
                lastQrAt: null,
              }
            : {}),
        }),
      );
    }
    if (
      row.companyId
        ? row.instanceName !== evolutionInstanceName(row.companyId, environment)
        : environment === 'DEV'
          ? row.instanceName !== evolutionGlobalName(environment)
          : !safeProductionGlobalName(row.instanceName)
    ) {
      throw new ServiceUnavailableException('EVOLUTION_ENVIRONMENT_MISMATCH');
    }
  }
  private view(row: Snapshot) {
    const code = row.temporaryCode;
    const available =
      !!code &&
      code.expiresAt > Date.now() &&
      ['QR_AVAILABLE', 'CONNECTING'].includes(row.status);
    return {
      status:
        available && code.qrCode && code.mode === 'qr'
          ? 'QR_AVAILABLE'
          : row.status,
      phone: row.phone,
      profileName: row.profileName,
      connectedAt: row.connectedAt,
      qrCode: available && code.mode === 'qr' ? code.qrCode : null,
      pairingCode: available && code.mode === 'phone' ? code.pairingCode : null,
      qrExpiresAt: row.codeFingerprint?.startsWith('qr:')
        ? (row.codeExpiresAt?.toISOString() ?? null)
        : null,
      pairingExpiresAt: row.codeFingerprint?.startsWith('phone:')
        ? (row.codeExpiresAt?.toISOString() ?? null)
        : null,
      pairingSupported: true,
      errorCode: row.lastError,
      message: row.lastError
        ? (messages[row.lastError] ??
          'Não foi possível concluir a conexão. Tente novamente.')
        : null,
    };
  }
  private async lock<T>(
    row: EvolutionConnection,
    operation: (leaseId: string) => Promise<T>,
  ): Promise<T> {
    const leaseId = randomUUID();
    const claimed = await this.db.evolutionConnection.updateMany({
      where: {
        id: row.id,
        OR: [{ leaseId: null }, { leaseExpiresAt: { lt: new Date() } }],
      },
      data: { leaseId, leaseExpiresAt: new Date(Date.now() + 120000) },
    });
    if (!claimed.count)
      throw new ConflictException(
        'Uma operação de WhatsApp está em andamento. Aguarde.',
      );
    try {
      Object.assign(
        row,
        await this.db.evolutionConnection.findUniqueOrThrow({
          where: { id: row.id },
        }),
      );
      await this.bindEnvironment(row, leaseId);
      return await operation(leaseId);
    } finally {
      await this.db.evolutionConnection.updateMany({
        where: { id: row.id, leaseId },
        data: { leaseId: null, leaseExpiresAt: null },
      });
    }
  }
  private async write(
    id: string,
    leaseId: string,
    data: Prisma.EvolutionConnectionUpdateManyMutationInput,
  ) {
    const result = await this.db.evolutionConnection.updateMany({
      where: { id, leaseId, leaseExpiresAt: { gt: new Date() } },
      data,
    });
    if (!result.count)
      throw new ConflictException('A operação expirou. Atualize a conexão.');
    const row = await this.db.evolutionConnection.findUniqueOrThrow({
      where: { id },
    });
    if (data.status !== undefined) await this.syncGlobalProvider(row);
    return row;
  }
  private async failure(
    row: EvolutionConnection,
    leaseId: string,
    error: unknown,
  ) {
    if (error instanceof ConflictException) throw error;
    const code =
      error instanceof EvolutionFailure ? error.code : 'EVOLUTION_UNAVAILABLE';
    this.logger.warn(`Connection operation failed: ${code}`);
    return this.view(
      await this.write(row.id, leaseId, {
        status: 'ERROR',
        lastError: code,
        ...(code === 'CONNECTION_NOT_FOUND' ? { prepared: false } : {}),
      }),
    );
  }
  private webhookUrl(row: EvolutionConnection) {
    const { webhookOrigin } = this.configuration();
    return new URL(
      `/webhooks/communication/evolution/${row.globalKey === 'GLOBAL' ? 'global/' : ''}${row.id}`,
      webhookOrigin,
    ).href;
  }
  private async provision(row: EvolutionConnection, leaseId: string) {
    this.configuration();
    if (row.prepared) return row;
    row = await this.write(row.id, leaseId, {
      status: 'CREATING',
      lastError: null,
    });
    let existing = await this.client.fetchInstances(row.instanceName);
    if (!existing) {
      this.logger.log('Creating instance');
      try {
        await this.client.createInstance(row.instanceName);
      } catch (error) {
        // Includes ambiguous timeouts and Evolution's 400 for duplicate names.
        existing = await this.client.fetchInstances(row.instanceName);
        if (!existing) throw error;
      }
      this.logger.log('Instance created or recovered');
    }
    if (existing?.integration && existing.integration !== 'WHATSAPP-BAILEYS')
      throw new EvolutionFailure('INSTANCE_CREATION_FAILED');
    const token = row.webhookSecretEncrypted
      ? this.vault.decrypt(row.webhookSecretEncrypted, `evolution:${row.id}`)
      : randomBytes(32).toString('hex');
    if (!row.webhookSecretEncrypted)
      row = await this.write(row.id, leaseId, {
        webhookSecretEncrypted: this.vault.encrypt(
          token,
          `evolution:${row.id}`,
        ),
      });
    await this.client.setWebhook(row.instanceName, this.webhookUrl(row), token);
    return this.write(row.id, leaseId, { prepared: true, status: 'CREATED' });
  }
  private async capture(
    row: EvolutionConnection,
    leaseId: string,
    result: unknown,
    mode: Code['mode'],
  ): Promise<Code | null> {
    const raw = record(result);
    const qr = record(raw.qrcode ?? result);
    const qrCode = evolutionQr(qr.base64);
    const pairingCode =
      typeof qr.pairingCode === 'string' &&
      /^[A-Za-z0-9-]{8,12}$/.test(qr.pairingCode)
        ? qr.pairingCode
        : null;
    if (!qrCode && !pairingCode) return null;
    const displayMode =
      mode === 'phone' && !pairingCode && qrCode ? 'qr' : mode;
    const identity = displayMode === 'phone' ? pairingCode! : qrCode!;
    // HMAC prevents offline guessing of short pairing codes. No payload is stored.
    const key = this.vault.decrypt(
      row.webhookSecretEncrypted!,
      `evolution:${row.id}`,
    );
    const fingerprint =
      displayMode +
      ':' +
      createHmac('sha256', key).update(identity).digest('hex');
    const same =
      row.codeFingerprint === fingerprint && row.codeExpiresAt != null;
    const expiresAt = same ? row.codeExpiresAt!.getTime() : Date.now() + 45000;
    Object.assign(
      row,
      await this.write(row.id, leaseId, {
        codeFingerprint: fingerprint,
        codeExpiresAt: new Date(expiresAt),
        ...(same ? {} : { lastQrAt: new Date() }),
      }),
    );
    return { qrCode, pairingCode, mode: displayMode, expiresAt };
  }
  private async recovery(
    row: EvolutionConnection,
    leaseId: string,
    number?: string,
  ) {
    if (
      !row.connectionRequested ||
      (row.lastRecoveryAt && Date.now() - row.lastRecoveryAt.getTime() < 30000)
    )
      return null;
    // Only recover a pending/expired attempt. Never restart an already connected session or create/delete here.
    const state = record(
      record(await this.client.fetchConnectionState(row.instanceName)).instance,
    ).state;
    if (state === 'open') return null;
    Object.assign(
      row,
      await this.write(row.id, leaseId, { lastRecoveryAt: new Date() }),
    );
    if (state === 'connecting')
      await this.client.restartInstance(row.instanceName);
    // Evolution 2.3.7 refuses restart on close: connect itself starts a new handshake in that state.
    const result = await this.client.connectInstance(row.instanceName, number);
    return this.capture(
      row,
      leaseId,
      result,
      number || row.pairingMethod === 'PHONE' ? 'phone' : 'qr',
    );
  }
  private async refresh(
    row: EvolutionConnection,
    leaseId: string,
    requestCode = false,
    number?: string,
  ): Promise<Snapshot> {
    const state = record(
      record(await this.client.fetchConnectionState(row.instanceName)).instance,
    ).state;
    let status = evolutionStatus(state);
    let profile: Record<string, unknown> = {};
    let lastError: string | null = null;
    let code: Code | null = null;
    if (status === 'CONNECTED') {
      profile = (await this.client.fetchInstances(row.instanceName)) ?? {};
    } else if (requestCode) {
      if (!row.codeExpiresAt)
        Object.assign(
          row,
          await this.write(row.id, leaseId, {
            codeExpiresAt: new Date(Date.now() + 45000),
          }),
        );
      const mode = number || row.pairingMethod === 'PHONE' ? 'phone' : 'qr';
      const result = await this.client.connectInstance(
        row.instanceName,
        number,
      );
      // A connect payload/code is not proof of connection; confirm the authoritative state.
      const confirmedOpen =
        record(record(result).instance).state === 'open' &&
        record(
          record(await this.client.fetchConnectionState(row.instanceName))
            .instance,
        ).state === 'open';
      if (confirmedOpen) status = 'CONNECTED';
      else {
        code = await this.capture(row, leaseId, result, mode);
        if (
          (!code || code.expiresAt <= Date.now()) &&
          row.codeExpiresAt &&
          row.codeExpiresAt.getTime() <= Date.now()
        )
          code = (await this.recovery(row, leaseId, number)) ?? code;
        status = code?.mode === 'qr' ? 'QR_AVAILABLE' : 'CONNECTING';
        if (!code || code.expiresAt <= Date.now())
          lastError =
            mode === 'phone' ? 'PAIRING_CODE_UNAVAILABLE' : 'QR_UNAVAILABLE';
        else if (mode === 'phone' && code.mode === 'qr')
          lastError = 'PAIRING_CODE_UNAVAILABLE';
      }
      this.logger.log('Connection code requested');
    }
    const jid =
      typeof profile.ownerJid === 'string'
        ? profile.ownerJid.split('@')[0].split(':')[0]
        : '';
    const phone = /^[1-9]\d{7,14}$/.test(jid) ? '+' + jid : undefined;
    const current = await this.write(row.id, leaseId, {
      status,
      lastSeenAt: new Date(),
      lastError,
      ...(phone ? { phone } : {}),
      ...(typeof profile.profileName === 'string'
        ? { profileName: profile.profileName.slice(0, 200) }
        : {}),
      ...(status === 'CONNECTED'
        ? {
            connectionRequested: false,
            codeFingerprint: null,
            codeExpiresAt: null,
            ...(row.status !== 'CONNECTED' ? { connectedAt: new Date() } : {}),
          }
        : {}),
      ...(status === 'DISCONNECTED' && row.status === 'CONNECTED'
        ? { disconnectedAt: new Date() }
        : {}),
    });
    return {
      ...current,
      ...(status !== 'CONNECTED' && code ? { temporaryCode: code } : {}),
    };
  }
  private async syncGlobalProvider(row: EvolutionConnection) {
    if (row.globalKey !== 'GLOBAL') return;
    await this.db.globalCommunicationProvider.upsert({
      where: { provider: 'EVOLUTION' },
      create: {
        provider: 'EVOLUTION',
        scope: 'GLOBAL',
        environment: 'PRODUCTION',
        config: {},
        enabled: false,
        status: row.status === 'CONNECTED' ? 'CONNECTED' : 'PENDING_VALIDATION',
      },
      update: {
        environment: 'PRODUCTION',
        status:
          row.status === 'CONNECTED'
            ? 'CONNECTED'
            : row.status === 'ERROR'
              ? 'FAILED'
              : 'PENDING_VALIDATION',
      },
    });
  }
  async globalConnection() {
    const row = await this.ensure(GLOBAL_EVOLUTION);
    return this.lock(row, async () => row);
  }
  async sendGlobalTextMessage(userId: string, text: string) {
    // Global messages are system notifications to active owners/admin, never arbitrary tenant clients.
    const user = await this.db.user.findFirst({
      where: {
        id: userId,
        isActive: true,
        OR: [
          { isSuperAdmin: true },
          {
            memberships: {
              some: {
                role: 'OWNER',
                isActive: true,
                company: { isActive: true },
              },
            },
          },
        ],
      },
      select: { phone: true },
    });
    if (!user?.phone)
      throw new ServiceUnavailableException(
        'Destinatário global indisponível.',
      );
    const row = await this.ensure(GLOBAL_EVOLUTION);
    return this.lock(row, async (leaseId) => {
      try {
        if (!row.prepared) throw new EvolutionFailure('CONNECTION_FAILED');
        const current = await this.refresh(row, leaseId);
        if (current.status !== 'CONNECTED')
          throw new EvolutionFailure('CONNECTION_FAILED');
        return await this.client.sendTextMessage(
          row.instanceName,
          evolutionPhone(user.phone),
          text,
        );
      } catch {
        throw new ServiceUnavailableException(
          'Não foi possível enviar a mensagem global.',
        );
      }
    });
  }
  async prepare(companyId: EvolutionContext) {
    const row = await this.ensure(companyId);
    return this.lock(row, async (leaseId) => {
      try {
        let prepared = await this.provision(row, leaseId);
        prepared = await this.write(row.id, leaseId, {
          connectionRequested: true,
        });
        return this.view(await this.refresh(prepared, leaseId, true));
      } catch (error) {
        return this.failure(row, leaseId, error);
      }
    });
  }
  async prepareAfterCompanyCreated(companyId: string) {
    try {
      await this.prepare(companyId);
    } catch {
      this.logger.warn(
        'Automatic preparation deferred; connection can be retried',
      );
    }
  }
  async get(companyId: EvolutionContext) {
    const row = await this.ensure(companyId);
    return this.lock(row, async (leaseId) => {
      try {
        // Poll only active pairing; never reconnect a deliberately logged-out session.
        if (!row.prepared) return this.view(row);
        const active = row.connectionRequested;
        const requestCode = active;
        return this.view(await this.refresh(row, leaseId, requestCode));
      } catch (error) {
        return this.failure(row, leaseId, error);
      }
    });
  }
  async connect(companyId: EvolutionContext, number?: string) {
    if (number !== undefined) {
      try {
        number = evolutionPhone(number);
      } catch {
        throw new BadRequestException(
          'Informe o número com DDI, por exemplo +5511999999999.',
        );
      }
    }
    const row = await this.ensure(companyId);
    return this.lock(row, async (leaseId) => {
      try {
        let prepared = await this.provision(row, leaseId);
        const state = record(
          record(await this.client.fetchConnectionState(row.instanceName))
            .instance,
        ).state;
        if (state === 'open')
          return this.view(await this.refresh(prepared, leaseId));
        // Baileys ignores a new number while connecting; close the pending session before switching modes.
        if (state === 'connecting')
          await this.client.logoutInstance(row.instanceName);
        prepared = await this.write(row.id, leaseId, {
          pairingMethod: number ? 'PHONE' : 'QR',
        });
        prepared = await this.write(row.id, leaseId, {
          connectionRequested: true,
          codeFingerprint: null,
          codeExpiresAt: null,
          lastRecoveryAt: null,
        });
        return this.view(await this.refresh(prepared, leaseId, true, number));
      } catch (error) {
        return this.failure(row, leaseId, error);
      }
    });
  }
  async logout(companyId: EvolutionContext) {
    const row = await this.ensure(companyId);
    return this.lock(row, async (leaseId) => {
      try {
        if (row.prepared) {
          const state = record(
            record(await this.client.fetchConnectionState(row.instanceName))
              .instance,
          ).state;
          if (state !== 'close')
            await this.client.logoutInstance(row.instanceName);
        }
        this.logger.log('Disconnected');
        return this.view(
          await this.write(row.id, leaseId, {
            status: 'DISCONNECTED',
            connectionRequested: false,
            codeFingerprint: null,
            codeExpiresAt: null,
            disconnectedAt: new Date(),
            lastError: null,
          }),
        );
      } catch (error) {
        return this.failure(row, leaseId, error);
      }
    });
  }
  async remove(companyId: EvolutionContext) {
    const row = await this.ensure(companyId);
    return this.lock(row, async (leaseId) => {
      try {
        await this.write(row.id, leaseId, {
          status: 'DELETING',
          lastError: null,
        });
        // Check even partially provisioned instances, including ambiguous create timeouts.
        if (await this.client.fetchInstances(row.instanceName)) {
          const state = record(
            record(await this.client.fetchConnectionState(row.instanceName))
              .instance,
          ).state;
          if (state !== 'close')
            await this.client.logoutInstance(row.instanceName);
          try {
            await this.client.deleteInstance(row.instanceName);
          } catch (error) {
            if (!(
              error instanceof EvolutionFailure &&
              error.code === 'CONNECTION_NOT_FOUND'
            ))
              throw error;
          }
        }
        return this.view(
          await this.write(row.id, leaseId, {
            prepared: false,
            connectionRequested: false,
            codeFingerprint: null,
            codeExpiresAt: null,
            lastRecoveryAt: null,
            pairingMethod: 'QR',
            status: 'PENDING',
            phone: null,
            profileName: null,
            connectedAt: null,
            disconnectedAt: null,
            lastQrAt: null,
            lastError: null,
            webhookSecretEncrypted: null,
            lastWebhookAt: null,
          }),
        );
      } catch (error) {
        return this.failure(row, leaseId, error);
      }
    });
  }
  async sendTextMessage(companyId: string, number: string, text: string) {
    const row = await this.ensure(companyId);
    return this.lock(row, async (leaseId) => {
      try {
        if (!row.prepared) throw new EvolutionFailure('CONNECTION_FAILED');
        const refreshed = await this.refresh(row, leaseId);
        if (refreshed.status !== 'CONNECTED')
          throw new EvolutionFailure('CONNECTION_FAILED');
        return await this.client.sendTextMessage(
          row.instanceName,
          number,
          text,
        );
      } catch {
        throw new ServiceUnavailableException(
          'Não foi possível enviar a mensagem.',
        );
      }
    });
  }
  async webhook(
    id: string,
    token: string | undefined,
    body: unknown,
    scope: 'COMPANY' | 'GLOBAL' = 'COMPANY',
  ) {
    const row = await this.db.evolutionConnection.findUnique({ where: { id } });
    if (
      !row ||
      (scope === 'GLOBAL'
        ? row.globalKey !== 'GLOBAL' || row.companyId !== null
        : !row.companyId || row.globalKey != null) ||
      !row.webhookSecretEncrypted ||
      !token ||
      !/^[a-f0-9]{64}$/.test(token)
    )
      throw new UnauthorizedException('Webhook inválido.');
    const { environment } = this.configuration();
    if (
      row.environment !== environment ||
      (row.companyId
        ? row.instanceName !== evolutionInstanceName(row.companyId, environment)
        : environment === 'DEV'
          ? row.instanceName !== evolutionGlobalName(environment)
          : !safeProductionGlobalName(row.instanceName))
    )
      throw new UnauthorizedException('Webhook inválido.');
    const validatedSecret = row.webhookSecretEncrypted;
    const expected = this.vault.decrypt(
      row.webhookSecretEncrypted,
      `evolution:${row.id}`,
    );
    if (!timingSafeEqual(Buffer.from(token), Buffer.from(expected)))
      throw new UnauthorizedException('Webhook inválido.');
    const payload = record(body);
    if (payload.instance !== row.instanceName)
      throw new UnauthorizedException('Webhook inválido.');
    const event = payload.event;
    if (event !== 'qrcode.updated' && event !== 'connection.update')
      return { accepted: true };
    const date =
      typeof payload.date_time === 'string'
        ? new Date(payload.date_time)
        : null;
    if (
      !date ||
      !Number.isFinite(date.getTime()) ||
      date.getTime() > Date.now() + 60000
    )
      throw new BadRequestException('Evento inválido.');
    if (row.lastWebhookAt && date <= row.lastWebhookAt)
      return { accepted: true };
    // Busy responses must be retried by Evolution, avoiding lost updates during provisioning.
    try {
      return await this.lock(row, async (leaseId) => {
        const latest = await this.db.evolutionConnection.findUniqueOrThrow({
          where: { id },
        });
        if (
          latest.webhookSecretEncrypted !== validatedSecret ||
          !latest.webhookSecretEncrypted
        )
          throw new UnauthorizedException('Webhook inválido.');
        if (latest.lastWebhookAt && date <= latest.lastWebhookAt)
          return { accepted: true };
        const data = record(payload.data);
        if (event === 'qrcode.updated') {
          // A late QR must not resurrect a connected or logged-out connection.
          const state = record(
            record(await this.client.fetchConnectionState(row.instanceName))
              .instance,
          ).state;
          const code =
            state === 'connecting' && row.connectionRequested
              ? await this.capture(
                  row,
                  leaseId,
                  data,
                  latest.pairingMethod === 'PHONE' ? 'phone' : 'qr',
                )
              : null;
          await this.write(id, leaseId, {
            ...(code
              ? {
                  status: code.mode === 'phone' ? 'CONNECTING' : 'QR_AVAILABLE',
                  lastQrAt: new Date(),
                  lastError: null,
                }
              : {}),
            lastWebhookAt: date,
          });
        } else {
          // Reconcile with authoritative remote state, never trust a delayed state event alone.
          const updated = await this.refresh(latest, leaseId);
          if (
            updated.connectionRequested &&
            ['DISCONNECTED', 'ERROR', 'PENDING'].includes(updated.status)
          )
            await this.write(id, leaseId, { status: 'CONNECTING' });
          await this.write(id, leaseId, { lastWebhookAt: date });
          this.logger.log('Connection updated');
        }
        return { accepted: true };
      });
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new ServiceUnavailableException(
        'Evento temporariamente indisponível.',
      );
    }
  }
}
