import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
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
  record,
} from './evolution-client.js';
import {
  ATTEMPT_TTL_MS,
  CLEAR_ATTEMPT,
  attemptTimedOut,
  codePatch,
  evolutionMessages as messages,
  savedCode,
} from './evolution-state.js';

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
// An event superseded the remote operation. Never overwrite it with a stale response.
class StateChanged extends Error {}

@Injectable()
export class EvolutionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('EVOLUTION');
  private maintenanceTimer?: ReturnType<typeof setInterval>;
  private maintaining = false;
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
  private log(
    row: EvolutionConnection,
    action: string,
    detail: Record<string, string | number | null> = {},
  ) {
    // Explicit allowlisted fields only. Never serialize exceptions/provider bodies/DTOs.
    this.logger.log(
      JSON.stringify({
        action,
        connectionId: row.id,
        instanceName: row.instanceName,
        context: row.companyId ? 'COMPANY' : 'GLOBAL',
        companyId: row.companyId,
        ...detail,
      }),
    );
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
        await this.write(row, leaseId, {
          environment,
          instanceName: name,
          prepared: false,
          status: 'PENDING',
          ...CLEAR_ATTEMPT,
          webhookSecretEncrypted: null,
          lastWebhookAt: null,
          lastConnectionEventAt: null,
          attemptStartedAt: null,
          disconnectReason: null,
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
  private view(row: EvolutionConnection) {
    const available =
      row.connectionRequested &&
      ['QR_AVAILABLE', 'CONNECTING'].includes(row.status);
    const code = available ? savedCode(row, this.vault) : null;
    const timedOut = attemptTimedOut(row);
    const expired =
      row.codeExpiresAt != null && row.codeExpiresAt.getTime() <= Date.now();
    const operationPending =
      !!row.leaseId &&
      !!row.leaseExpiresAt &&
      row.leaseExpiresAt.getTime() > Date.now();
    const errorCode = timedOut
      ? 'CONNECTION_TIMEOUT'
      : expired && available
        ? 'CODE_EXPIRED'
        : row.lastError;
    return {
      status: timedOut
        ? ('ERROR' as const)
        : code?.qrCode
          ? ('QR_AVAILABLE' as const)
          : row.status,
      phone: row.phone,
      profileName: row.profileName,
      connectedAt: row.connectedAt,
      qrCode: !timedOut && code?.mode === 'qr' ? code.qrCode : null,
      pairingCode:
        !timedOut && code?.mode === 'phone' ? code.pairingCode : null,
      qrExpiresAt: row.codeFingerprint?.startsWith('qr:')
        ? (row.codeExpiresAt?.toISOString() ?? null)
        : null,
      pairingExpiresAt: row.codeFingerprint?.startsWith('phone:')
        ? (row.codeExpiresAt?.toISOString() ?? null)
        : null,
      attemptExpiresAt: row.attemptExpiresAt?.toISOString() ?? null,
      disconnectReason: row.disconnectReason,
      pairingSupported: true,
      operationPending,
      errorCode,
      message: errorCode
        ? (messages[errorCode] ?? messages.INTEGRATION_INTERNAL_ERROR)
        : operationPending
          ? messages.OPERATION_IN_PROGRESS
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
      throw new ConflictException({
        errorCode: 'OPERATION_IN_PROGRESS',
        message: messages.OPERATION_IN_PROGRESS,
      });
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
  // Short transaction, no network. CAS protects callbacks and remote responses across replicas.
  private async persist(
    row: EvolutionConnection,
    data: Prisma.EvolutionConnectionUpdateManyMutationInput,
    leaseId?: string,
  ) {
    const updated = await this.db.$transaction(async (tx) => {
      const result = await tx.evolutionConnection.updateMany({
        where: {
          id: row.id,
          version: row.version,
          ...(leaseId ? { leaseId, leaseExpiresAt: { gt: new Date() } } : {}),
        },
        data: { ...data, version: { increment: 1 } },
      });
      if (!result.count) throw new StateChanged();
      const current = await tx.evolutionConnection.findUniqueOrThrow({
        where: { id: row.id },
      });
      if (data.status !== undefined) await this.syncGlobalProvider(current, tx);
      return current;
    });
    Object.assign(row, updated);
    return row;
  }
  private write(
    row: EvolutionConnection,
    leaseId: string,
    data: Prisma.EvolutionConnectionUpdateManyMutationInput,
  ) {
    return this.persist(row, data, leaseId);
  }
  private async latest(row: EvolutionConnection) {
    return this.db.evolutionConnection.findUniqueOrThrow({
      where: { id: row.id },
    });
  }
  private async failure(
    row: EvolutionConnection,
    leaseId: string,
    error: unknown,
  ): Promise<ReturnType<EvolutionService['view']>> {
    if (error instanceof StateChanged) return this.view(await this.latest(row));
    if (error instanceof HttpException) throw error;
    const code =
      error instanceof EvolutionFailure
        ? error.code
        : 'INTEGRATION_INTERNAL_ERROR';
    this.log(row, 'Connection operation failed', {
      errorCode: code,
      httpStatus:
        error instanceof EvolutionFailure ? (error.status ?? null) : 500,
    });
    try {
      await this.write(row, leaseId, {
        status:
          error instanceof EvolutionFailure &&
          [
            'EVOLUTION_UNAVAILABLE',
            'EVOLUTION_TIMEOUT',
            'EVOLUTION_RATE_LIMITED',
          ].includes(error.code) &&
          row.connectionRequested &&
          savedCode(row, this.vault)
            ? row.status
            : 'ERROR',
        lastError: code,
        ...(code === 'CONNECTION_NOT_FOUND' ? { prepared: false } : {}),
      });
    } catch (changed) {
      if (changed instanceof StateChanged)
        return this.view(await this.latest(row));
      throw new HttpException(
        {
          errorCode: 'INTEGRATION_INTERNAL_ERROR',
          message: messages.INTEGRATION_INTERNAL_ERROR,
        },
        500,
      );
    }
    throw new HttpException(
      {
        errorCode: code,
        message: messages[code] ?? messages.INTEGRATION_INTERNAL_ERROR,
      },
      error instanceof EvolutionFailure ? error.httpStatus : 500,
    );
  }
  private async manage(
    context: EvolutionContext,
    operation: (
      row: EvolutionConnection,
      leaseId: string,
    ) => Promise<ReturnType<EvolutionService['view']>>,
    coalesce = false,
  ) {
    const row = await this.ensure(context);
    try {
      await this.lock(row, async (leaseId) => {
        try {
          return await operation(row, leaseId);
        } catch (error) {
          return this.failure(row, leaseId, error);
        }
      });
      // An expired lease may have been replaced by another process; expose the actual current state.
      return this.view(await this.latest(row));
    } catch (error) {
      if (
        error instanceof StateChanged ||
        (coalesce && error instanceof ConflictException)
      )
        return this.view(await this.latest(row));
      throw error;
    }
  }
  private webhookUrl(row: EvolutionConnection) {
    return new URL(
      `/webhooks/communication/evolution/${row.globalKey === 'GLOBAL' ? 'global/' : ''}${row.id}`,
      this.configuration().webhookOrigin,
    ).href;
  }
  private async provision(row: EvolutionConnection, leaseId: string) {
    this.log(row, 'Instance prepare started');
    if (!row.prepared)
      await this.write(row, leaseId, { status: 'CREATING', lastError: null });
    let existing = await this.client.fetchInstances(row.instanceName);
    if (!existing) {
      try {
        await this.client.createInstance(row.instanceName);
      } catch (error) {
        existing = await this.client.fetchInstances(row.instanceName);
        if (!existing) throw error;
      }
      this.log(row, 'Instance created or recovered');
    }
    if (existing?.integration && existing.integration !== 'WHATSAPP-BAILEYS')
      throw new EvolutionFailure('INSTANCE_CREATION_FAILED');
    const token = row.webhookSecretEncrypted
      ? this.vault.decrypt(row.webhookSecretEncrypted, `evolution:${row.id}`)
      : randomBytes(32).toString('hex');
    if (!row.webhookSecretEncrypted)
      await this.write(row, leaseId, {
        webhookSecretEncrypted: this.vault.encrypt(
          token,
          `evolution:${row.id}`,
        ),
      });
    // Explicit preparation repairs remote webhook drift; status polling never reconfigures it.
    await this.client.setWebhook(row.instanceName, this.webhookUrl(row), token);
    await this.write(row, leaseId, {
      prepared: true,
      provisionRequested: false,
      provisionRetryAt: null,
      ...(row.status === 'CREATING' ? { status: 'CREATED' } : {}),
    });
  }
  private pairingPhone(row: EvolutionConnection) {
    return row.pairingPhoneEncrypted &&
      row.attemptExpiresAt &&
      row.attemptExpiresAt.getTime() > Date.now()
      ? evolutionPhone(
          this.vault.decrypt(
            row.pairingPhoneEncrypted,
            `evolution:phone:${row.id}`,
          ),
        )
      : undefined;
  }
  private async capture(
    row: EvolutionConnection,
    leaseId: string,
    result: unknown,
  ) {
    const patch = codePatch(row, result, this.vault);
    if (patch) {
      await this.write(row, leaseId, patch);
      this.log(
        row,
        patch.codeFingerprint.startsWith('phone:')
          ? 'Pairing received'
          : 'QR received',
      );
    }
    return patch;
  }
  private async refresh(row: EvolutionConnection, leaseId: string) {
    const state = record(
      record(await this.client.fetchConnectionState(row.instanceName)).instance,
    ).state;
    if (!['open', 'close', 'connecting', 'refused'].includes(String(state)))
      throw new EvolutionFailure('EVOLUTION_INVALID_RESPONSE');
    let profile: Record<string, unknown> = {};
    if (state === 'open' && (!row.phone || !row.profileName))
      profile = (await this.client.fetchInstances(row.instanceName)) ?? {};
    const jid =
      typeof profile.ownerJid === 'string'
        ? profile.ownerJid.split('@')[0].split(':')[0]
        : '';
    const status = evolutionStatus(state);
    const terminalAttempt =
      state === 'connecting' &&
      !row.connectionRequested &&
      ['CONNECTION_TIMEOUT', 'WHATSAPP_LOGGED_OUT'].includes(
        row.lastError ?? '',
      );
    await this.write(row, leaseId, {
      status: terminalAttempt
        ? row.status
        : state === 'connecting' && savedCode(row, this.vault)?.qrCode
          ? 'QR_AVAILABLE'
          : status,
      lastSeenAt: new Date(),
      ...(/^[1-9]\d{7,14}$/.test(jid) ? { phone: '+' + jid } : {}),
      ...(typeof profile.profileName === 'string'
        ? { profileName: profile.profileName.slice(0, 200) }
        : {}),
      ...(state === 'open'
        ? {
            ...CLEAR_ATTEMPT,
            lastError: null,
            disconnectReason: null,
            ...(row.status !== 'CONNECTED' ? { connectedAt: new Date() } : {}),
          }
        : {}),
      ...(state === 'close' || state === 'refused'
        ? {
            ...CLEAR_ATTEMPT,
            disconnectedAt: row.disconnectedAt ?? new Date(),
            lastError:
              row.lastError === 'WHATSAPP_LOGGED_OUT'
                ? row.lastError
                : 'WHATSAPP_CONNECTION_CLOSED',
          }
        : {}),
    });
    return row;
  }
  private async requestConnection(
    row: EvolutionConnection,
    leaseId: string,
    number?: string,
  ) {
    const state = record(
      record(await this.client.fetchConnectionState(row.instanceName)).instance,
    ).state;
    if (state === 'open') return this.view(await this.refresh(row, leaseId));
    if (state !== 'connecting' && state !== 'close')
      throw new EvolutionFailure('EVOLUTION_INVALID_RESPONSE');
    const desiredMethod = number ? 'PHONE' : 'QR';
    const currentPhone = this.pairingPhone(row);
    const switching =
      row.pairingMethod !== desiredMethod ||
      (number != null && currentPhone !== number);
    const expired =
      !!row.codeExpiresAt && row.codeExpiresAt.getTime() <= Date.now();
    const timedOut =
      attemptTimedOut(row) ||
      (!row.connectionRequested && row.lastError === 'CONNECTION_TIMEOUT');
    // Opening/repeating a valid request leaves the current attempt and codes intact.
    if (
      state === 'connecting' &&
      !switching &&
      !expired &&
      !timedOut &&
      row.connectionRequested &&
      ['QR_AVAILABLE', 'CONNECTING'].includes(row.status) &&
      savedCode(row, this.vault)
    )
      return this.view(row);
    if (state === 'connecting' && expired && !switching && !timedOut) {
      // The provider may have rotated its QR while a callback was delayed. Fetch before restarting.
      const existing = await this.client.connectInstance(
        row.instanceName,
        number ?? this.pairingPhone(row),
      );
      const newer = await this.latest(row);
      if (newer.version !== row.version) return this.view(newer);
      if (record(record(existing).instance).state === 'open')
        return this.view(await this.refresh(row, leaseId));
      const code = codePatch(row, existing, this.vault);
      if (code?.codeEncrypted) {
        await this.write(row, leaseId, code);
        return this.view(row);
      }
    }
    // Baileys ignores a new phone in connecting. Cancel only an actual switch or expired PHONE handshake.
    if (
      !switching &&
      expired &&
      row.lastRecoveryAt &&
      Date.now() - row.lastRecoveryAt.getTime() < 30000
    )
      return this.view(row);
    const cancel =
      state === 'connecting' &&
      (switching || (desiredMethod === 'PHONE' && (expired || timedOut)));
    if (cancel) {
      await this.write(row, leaseId, {
        ...CLEAR_ATTEMPT,
        status: 'DISCONNECTED',
        attemptStartedAt: new Date(),
      });
      this.log(row, 'Pending attempt cancelled', {
        reason: switching ? 'MODE_OR_PHONE_CHANGED' : 'EXPIRED_PHONE_ATTEMPT',
      });
      const beforeCancel = record(
        record(await this.client.fetchConnectionState(row.instanceName))
          .instance,
      ).state;
      const current = await this.latest(row);
      if (beforeCancel === 'open') {
        Object.assign(row, current);
        return this.view(await this.refresh(row, leaseId));
      }
      if (current.version !== row.version) return this.view(current);
      await this.client.logoutInstance(row.instanceName);
    }
    if (
      !row.connectionRequested ||
      switching ||
      expired ||
      timedOut ||
      row.status === 'ERROR'
    ) {
      const started = new Date();
      const expiredIdentity =
        !switching && row.codeFingerprint
          ? {
              codeFingerprint: row.codeFingerprint,
              codeExpiresAt: row.codeExpiresAt,
            }
          : {};
      await this.write(row, leaseId, {
        ...CLEAR_ATTEMPT,
        ...expiredIdentity,
        connectionRequested: true,
        pairingMethod: desiredMethod,
        pairingPhoneEncrypted: number
          ? this.vault.encrypt(number, `evolution:phone:${row.id}`)
          : null,
        attemptStartedAt: started,
        attemptExpiresAt: new Date(started.getTime() + ATTEMPT_TTL_MS),
        status: 'CONNECTING',
        phone: null,
        profileName: null,
        connectedAt: null,
        disconnectReason: null,
        lastError: number ? 'PAIRING_CODE_UNAVAILABLE' : 'QR_UNAVAILABLE',
      });
    }
    if (!cancel && state === 'connecting' && (expired || timedOut)) {
      // New intention is committed first: QR callbacks emitted during restart can be accepted.
      await this.write(row, leaseId, { lastRecoveryAt: new Date() });
      await this.client.restartInstance(row.instanceName);
      const afterRestart = await this.latest(row);
      if (afterRestart.version !== row.version) return this.view(afterRestart);
    }
    this.log(row, number ? 'Pairing requested' : 'Connect requested');
    const result = await this.client.connectInstance(
      row.instanceName,
      number ?? this.pairingPhone(row),
    );
    // Callback may have committed while the request was in flight. Its newer state wins.
    const current = await this.latest(row);
    if (current.version !== row.version) return this.view(current);
    if (record(record(result).instance).state === 'open') {
      await this.refresh(row, leaseId);
      if (row.status === 'CONNECTED') return this.view(row);
    }
    await this.capture(row, leaseId, result);
    return this.view(row);
  }
  private async syncGlobalProvider(
    row: EvolutionConnection,
    tx: Prisma.TransactionClient,
  ) {
    if (row.globalKey !== 'GLOBAL') return;
    const status =
      row.status === 'CONNECTED'
        ? 'CONNECTED'
        : row.status === 'ERROR'
          ? 'FAILED'
          : 'PENDING_VALIDATION';
    await tx.globalCommunicationProvider.upsert({
      where: { provider: 'EVOLUTION' },
      create: {
        provider: 'EVOLUTION',
        scope: 'GLOBAL',
        environment: 'PRODUCTION',
        config: {},
        enabled: false,
        status,
      },
      update: { environment: 'PRODUCTION', status },
    });
  }
  async globalConnection() {
    const row = await this.ensure(GLOBAL_EVOLUTION);
    // Namespace verification remains mandatory, including legacy rows.
    return this.lock(row, async () => row);
  }
  async prepare(context: EvolutionContext) {
    return this.manage(
      context,
      async (row, leaseId) => {
        await this.provision(row, leaseId);
        if (
          row.connectionRequested &&
          ['QR_AVAILABLE', 'CONNECTING'].includes(row.status)
        )
          return this.view(row);
        if (row.status === 'CONNECTED' || row.status === 'DISCONNECTED')
          return this.view(await this.refresh(row, leaseId));
        return this.requestConnection(row, leaseId, this.pairingPhone(row));
      },
      true,
    );
  }
  async prepareAfterCompanyCreated(companyId: string) {
    try {
      const row = await this.ensure(companyId);
      await this.db.evolutionConnection.updateMany({
        where: { id: row.id, prepared: false },
        data: { provisionRequested: true, provisionRetryAt: new Date() },
      });
      // Durable flag remains if the process exits or network fails. No QR is requested here.
      await this.lock(row, async (leaseId) => this.provision(row, leaseId));
    } catch {
      // Company creation already committed its durable flag. Never reject this detached promise.
      this.logger.warn(
        'Automatic preparation deferred: INTEGRATION_CONFIGURATION_OR_PROVIDER_REQUIRED',
      );
    }
  }
  async get(context: EvolutionContext) {
    const row = await this.ensure(context);
    if (attemptTimedOut(row)) {
      try {
        await this.persist(row, {
          ...CLEAR_ATTEMPT,
          status: 'ERROR',
          lastError: 'CONNECTION_TIMEOUT',
        });
      } catch (error) {
        if (!(error instanceof StateChanged)) throw error;
        return this.view(await this.latest(row));
      }
    }
    if (
      !row.prepared ||
      (row.lastSeenAt && Date.now() - row.lastSeenAt.getTime() < 10000)
    )
      return this.view(row);
    try {
      await this.lock(row, async (leaseId) => this.refresh(row, leaseId));
      return this.view(row);
    } catch (error) {
      if (error instanceof StateChanged || error instanceof ConflictException)
        return this.view(await this.latest(row));
      // An unavailable provider must not make an already received QR disappear.
      if (error instanceof EvolutionFailure) {
        this.log(row, 'State reconciliation deferred', {
          errorCode: error.code,
          httpStatus: error.status ?? null,
        });
        return {
          ...this.view(await this.latest(row)),
          errorCode: error.code,
          message: messages[error.code] ?? messages.INTEGRATION_INTERNAL_ERROR,
        };
      }
      throw error;
    }
  }
  async connect(context: EvolutionContext, number?: string) {
    if (number !== undefined) {
      try {
        number = evolutionPhone(number);
      } catch {
        throw new BadRequestException({
          errorCode: 'INVALID_PHONE',
          message: 'Informe o número com DDI, por exemplo +5512996055129.',
        });
      }
    }
    return this.manage(
      context,
      async (row, leaseId) => {
        if (!row.prepared) await this.provision(row, leaseId);
        return this.requestConnection(row, leaseId, number);
      },
      true,
    );
  }
  async reconnect(context: EvolutionContext) {
    const row = await this.ensure(context);
    return this.connect(context, this.pairingPhone(row));
  }
  async logout(context: EvolutionContext) {
    return this.manage(context, async (row, leaseId) => {
      // Invalidate codes/attempt before remote I/O so late QR cannot resurrect the session.
      await this.write(row, leaseId, {
        ...CLEAR_ATTEMPT,
        attemptStartedAt: new Date(),
        status: 'DISCONNECTED',
        disconnectedAt: new Date(),
        lastError: 'WHATSAPP_LOGGED_OUT',
        disconnectReason: 401,
      });
      if (row.prepared) {
        const state = record(
          record(await this.client.fetchConnectionState(row.instanceName))
            .instance,
        ).state;
        if (state !== 'close')
          await this.client.logoutInstance(row.instanceName);
      }
      this.log(row, 'Logout');
      Object.assign(row, await this.latest(row));
      const completed = new Date();
      await this.write(row, leaseId, {
        ...CLEAR_ATTEMPT,
        status: 'DISCONNECTED',
        lastError: 'WHATSAPP_LOGGED_OUT',
        disconnectReason: 401,
        attemptStartedAt: completed,
        lastConnectionEventAt:
          row.lastConnectionEventAt && row.lastConnectionEventAt > completed
            ? row.lastConnectionEventAt
            : completed,
      });
      return this.view(row);
    });
  }
  async remove(context: EvolutionContext) {
    return this.manage(context, async (row, leaseId) => {
      await this.write(row, leaseId, {
        ...CLEAR_ATTEMPT,
        status: 'DELETING',
        lastError: null,
        webhookSecretEncrypted: null,
        attemptStartedAt: new Date(),
      });
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
      await this.write(row, leaseId, {
        ...CLEAR_ATTEMPT,
        prepared: false,
        provisionRequested: false,
        provisionRetryAt: null,
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
        lastConnectionEventAt: null,
        disconnectReason: null,
      });
      this.log(row, 'Connection deleted');
      return this.view(row);
    });
  }
  private async send(context: EvolutionContext, number: string, text: string) {
    let row: EvolutionConnection | undefined;
    let dispatched = false;
    try {
      row = await this.ensure(context);
      const connection = row;
      return await this.lock(connection, async (leaseId) => {
        if (!connection.prepared)
          throw new EvolutionFailure('CONNECTION_NOT_OPEN');
        await this.refresh(connection, leaseId);
        if (
          connection.status !== 'CONNECTED' ||
          (await this.latest(connection)).status !== 'CONNECTED'
        )
          throw new EvolutionFailure('CONNECTION_NOT_OPEN');
        dispatched = true;
        return this.client.sendTextMessage(
          connection.instanceName,
          number,
          text,
        );
      });
    } catch (error) {
      if (error instanceof EvolutionFailure) throw error;
      const code = dispatched
        ? 'MESSAGE_ACCEPTANCE_UNKNOWN'
        : error instanceof StateChanged
          ? 'CONNECTION_NOT_OPEN'
          : error instanceof ConflictException
            ? 'INTEGRATION_BUSY'
            : 'INTEGRATION_STATE_UNAVAILABLE';
      if (row)
        this.log(row, 'Connection operation failed', {
          errorCode: code,
          phase: dispatched ? 'SEND_DISPATCHED' : 'BEFORE_SEND',
        });
      else
        this.logger.warn(
          'Send preparation failed: INTEGRATION_STATE_UNAVAILABLE',
        );
      throw new EvolutionFailure(code, undefined, dispatched);
    }
  }
  private async recipient(where: Prisma.UserWhereInput) {
    try {
      return await this.db.user.findFirst({ where, select: { phone: true } });
    } catch {
      throw new EvolutionFailure('INTEGRATION_STATE_UNAVAILABLE');
    }
  }
  async sendGlobalTextMessage(userId: string, text: string) {
    const user = await this.recipient({
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
    });
    if (!user?.phone)
      throw new EvolutionFailure('GLOBAL_RECIPIENT_UNAVAILABLE');
    return this.send(GLOBAL_EVOLUTION, evolutionPhone(user.phone), text);
  }
  async sendTextMessage(companyId: string, number: string, text: string) {
    return this.send(uuid(companyId), evolutionPhone(number), text);
  }
  async sendCompanyTestMessage(companyId: string, userId: string) {
    const user = await this.recipient({
      id: userId,
      isActive: true,
      isSuperAdmin: false,
      memberships: {
        some: {
          companyId: uuid(companyId),
          role: { in: ['OWNER', 'ADMIN'] },
          isActive: true,
          company: { isActive: true },
        },
      },
    });
    if (!user?.phone)
      throw new BadRequestException({
        errorCode: 'TEST_RECIPIENT_UNAVAILABLE',
        message:
          'Informe seu telefone no perfil para receber a mensagem de teste.',
      });
    try {
      await this.sendTextMessage(
        companyId,
        user.phone,
        'Teste de comunicação WhatsApp da sua empresa no Kalend.',
      );
      return { accepted: true, delivered: false };
    } catch (error) {
      if (error instanceof EvolutionFailure)
        throw new HttpException(
          {
            errorCode: error.code,
            message:
              messages[error.code] ?? messages.INTEGRATION_INTERNAL_ERROR,
          },
          error.httpStatus,
        );
      throw error;
    }
  }
  async webhook(
    id: string,
    token: string | undefined,
    body: unknown,
    scope: 'COMPANY' | 'GLOBAL' = 'COMPANY',
  ) {
    let row = await this.db.evolutionConnection.findUnique({ where: { id } });
    const payload = record(body);
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
    const expected = this.vault.decrypt(validatedSecret, `evolution:${row.id}`);
    if (
      expected.length !== token.length ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(expected)) ||
      payload.instance !== row.instanceName
    )
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
    const data = record(payload.data);
    if (
      event === 'connection.update' &&
      !['open', 'connecting', 'close', 'refused'].includes(String(data.state))
    )
      throw new BadRequestException('Estado inválido.');
    this.log(row, 'Webhook received', { event });
    const started = Date.now();
    // Optimistic retry is only for short database writes, never remote operations or sleeps.
    for (let attempt = 0; attempt < 8; attempt++) {
      if (row.webhookSecretEncrypted !== validatedSecret)
        throw new UnauthorizedException('Webhook inválido.');
      if (row.attemptStartedAt && date < row.attemptStartedAt)
        return { accepted: true };
      const clock =
        event === 'qrcode.updated'
          ? row.lastWebhookAt
          : row.lastConnectionEventAt;
      if (
        clock &&
        (date < clock || (event === 'qrcode.updated' && date <= clock))
      )
        return { accepted: true };
      if (
        event === 'connection.update' &&
        clock &&
        date.getTime() === clock.getTime()
      ) {
        // Equal timestamps can belong to distinct transitions. Terminal close wins ties.
        const priority =
          data.state === 'connecting' ? 0 : data.state === 'open' ? 1 : 2;
        const currentPriority = ['CONNECTING', 'QR_AVAILABLE'].includes(
          row.status,
        )
          ? 0
          : row.status === 'CONNECTED'
            ? 1
            : 2;
        if (
          priority <= currentPriority &&
          !(
            data.state === 'close' &&
            data.statusReason === 401 &&
            row.disconnectReason !== 401
          )
        )
          return { accepted: true };
      }
      let patch: Prisma.EvolutionConnectionUpdateManyMutationInput;
      if (event === 'qrcode.updated') {
        if (
          !row.connectionRequested ||
          row.status === 'CONNECTED' ||
          row.status === 'DELETING' ||
          attemptTimedOut(row) ||
          (row.lastConnectionEventAt && date < row.lastConnectionEventAt)
        )
          return { accepted: true };
        const code = codePatch(row, data, this.vault, date);
        if (!code) {
          // Evolution's QR-limit event is valid but contains no image.
          if (
            typeof data.message !== 'string' ||
            typeof data.statusCode !== 'number'
          )
            throw new BadRequestException('Código inválido.');
          patch = {
            ...CLEAR_ATTEMPT,
            status: 'ERROR',
            lastError: 'CONNECTION_TIMEOUT',
            lastWebhookAt: date,
          };
        } else patch = { ...code, lastWebhookAt: date, lastSeenAt: new Date() };
      } else {
        const state = data.state;
        const reason =
          typeof data.statusReason === 'number' &&
          Number.isInteger(data.statusReason)
            ? data.statusReason
            : null;
        patch = {
          lastConnectionEventAt: date,
          lastSeenAt: new Date(),
          status: evolutionStatus(state),
          lastError: null,
        };
        if (
          (state === 'connecting' &&
            !row.connectionRequested &&
            ['WHATSAPP_LOGGED_OUT', 'CONNECTION_TIMEOUT'].includes(
              row.lastError ?? '',
            )) ||
          (state === 'open' &&
            !row.connectionRequested &&
            row.lastError === 'WHATSAPP_LOGGED_OUT' &&
            row.leaseId &&
            row.leaseExpiresAt &&
            row.leaseExpiresAt > new Date())
        ) {
          patch = { lastConnectionEventAt: date, lastSeenAt: new Date() };
        } else if (state === 'open') {
          patch = {
            ...patch,
            ...CLEAR_ATTEMPT,
            disconnectReason: null,
            connectedAt: row.status === 'CONNECTED' ? row.connectedAt : date,
          };
          const jid =
            typeof data.wuid === 'string'
              ? data.wuid.split('@')[0].split(':')[0]
              : '';
          if (/^[1-9]\d{7,14}$/.test(jid)) patch.phone = '+' + jid;
          if (typeof data.profileName === 'string')
            patch.profileName = data.profileName.slice(0, 200);
        } else if (state === 'close' || state === 'refused') {
          patch = {
            ...patch,
            ...CLEAR_ATTEMPT,
            disconnectReason: reason,
            disconnectedAt: date,
            lastError:
              reason === 401
                ? 'WHATSAPP_LOGGED_OUT'
                : 'WHATSAPP_CONNECTION_CLOSED',
          };
        } else if (row.status === 'CONNECTED' || !row.connectionRequested) {
          // A later connecting notification is meaningful, but never revives an old code.
          patch = {
            ...patch,
            codeEncrypted: null,
            codeExpiresAt: null,
            codeFingerprint: null,
          };
        } else if (savedCode(row, this.vault)?.qrCode)
          patch.status = 'QR_AVAILABLE';
      }
      try {
        await this.persist(row, patch);
        this.log(row, 'Webhook processed', {
          event,
          state:
            event === 'connection.update' ? String(data.state) : row.status,
          durationMs: Date.now() - started,
          httpStatus: 200,
        });
        this.log(
          row,
          event === 'qrcode.updated'
            ? row.codeFingerprint?.startsWith('phone:')
              ? 'Pairing received'
              : 'QR received'
            : data.state === 'open'
              ? 'Connection open'
              : data.state === 'close'
                ? 'Connection closed'
                : 'Connection updated',
          { reason: row.disconnectReason },
        );
        return { accepted: true };
      } catch (error) {
        if (!(error instanceof StateChanged)) {
          this.log(row, 'Webhook persistence failed', {
            errorCode: 'INTEGRATION_INTERNAL_ERROR',
            durationMs: Date.now() - started,
          });
          throw new HttpException(
            {
              errorCode: 'INTEGRATION_INTERNAL_ERROR',
              message: messages.INTEGRATION_INTERNAL_ERROR,
            },
            500,
          );
        }
        row = await this.latest(row);
      }
    }
    // Do not ACK an uncommitted event. Evolution retries 409; busy leases never reach here.
    throw new ConflictException({
      errorCode: 'EVENT_WRITE_CONFLICT',
      message: 'Reenvie o evento.',
    });
  }
  onModuleInit() {
    if (this.maintenanceTimer) return;
    this.maintenanceTimer = setInterval(() => {
      void this.maintenance();
    }, 30000);
    this.maintenanceTimer.unref();
  }
  onModuleDestroy() {
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
  }
  async maintenance() {
    if (this.maintaining) return;
    this.maintaining = true;
    try {
      const { environment } = this.configuration();
      // Ciphertexts are physically cleared within one sweep after their expiry, even without polling.
      await this.db.evolutionConnection.updateMany({
        where: {
          environment,
          codeEncrypted: { not: null },
          codeExpiresAt: { lte: new Date() },
        },
        data: { codeEncrypted: null, version: { increment: 1 } },
      });
      await this.db.evolutionConnection.updateMany({
        where: {
          environment,
          connectionRequested: true,
          OR: [
            { attemptExpiresAt: { lte: new Date() } },
            {
              codeFingerprint: null,
              attemptStartedAt: { lte: new Date(Date.now() - 60000) },
            },
          ],
        },
        data: {
          ...CLEAR_ATTEMPT,
          version: { increment: 1 },
          status: 'ERROR',
          lastError: 'CONNECTION_TIMEOUT',
        },
      });
      const pending = await this.db.evolutionConnection.findMany({
        where: {
          OR: [{ environment }, { environment: null }],
          provisionRequested: true,
          prepared: false,
          provisionRetryAt: { lte: new Date() },
        },
        take: 2,
      });
      for (const row of pending) {
        try {
          await this.lock(row, async (leaseId) => this.provision(row, leaseId));
        } catch (error) {
          if (!(error instanceof ConflictException)) {
            await this.db.evolutionConnection.updateMany({
              where: { id: row.id, provisionRequested: true },
              data: { provisionRetryAt: new Date(Date.now() + 60000) },
            });
            this.log(row, 'Automatic preparation deferred');
          }
        }
      }
    } catch {
      this.logger.warn(
        'Session maintenance deferred: INTEGRATION_INTERNAL_ERROR',
      );
    } finally {
      this.maintaining = false;
    }
  }
}
