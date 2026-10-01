import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ECDH, createECDH, createHash, randomUUID } from 'node:crypto';
import webpush from 'web-push';
import { PrismaService } from '../prisma/prisma.service.js';
import { SecretVault } from '../billing/secret-vault.js';
import { boolean, object, string, uuid } from '../common/validation.js';
import { allowedHost } from './network.js';
import { secureRequest } from './secure-http.js';
import { email, TransportFailure } from './contracts.js';
import type { Message, Transport, Variables } from './contracts.js';
import type { GatewayEnvironment, Prisma } from '@prisma/client';

function validCompanyId(value: unknown) {
  try {
    return typeof value === 'string' && uuid(value) === value;
  } catch {
    return false;
  }
}
const activeDevices = (
  userId: string,
): Prisma.GlobalPushSubscriptionWhereInput => ({
  userId,
  scope: 'GLOBAL',
  active: true,
  revokedAt: null,
  OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
});
export type PushRecipient = NonNullable<Message['pushRecipient']>;
export function pushTargets(
  recipient: PushRecipient,
): Prisma.GlobalPushSubscriptionWhereInput {
  if (
    !recipient.userId ||
    !['SANDBOX', 'PRODUCTION'].includes(recipient.environment) ||
    !['COMPANY', 'ACCOUNT', 'ADMIN_TEST'].includes(recipient.audience) ||
    (recipient.audience === 'COMPANY' &&
      !validCompanyId(recipient.companyId)) ||
    (recipient.audience !== 'COMPANY' && recipient.companyId !== undefined)
  )
    throw new TransportFailure('RECIPIENT');
  return {
    userId: recipient.userId,
    scope: 'GLOBAL',
    environment: recipient.environment,
    active: true,
    revokedAt: null,
    provider: 'WEB_PUSH',
    OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    ...(recipient.audience === 'COMPANY'
      ? {
          authorizations: {
            some: {
              companyId: recipient.companyId,
              userId: recipient.userId,
              active: true,
              revokedAt: null,
              membership: {
                isActive: true,
                company: {
                  OR: [
                    { isActive: true },
                    { status: { in: ['SUSPENDED', 'CANCELED'] } },
                  ],
                },
              },
            },
          },
        }
      : {}),
  };
}

export const pushScope = (id: string) => `communication:GLOBAL:push:${id}`;
export function pushEndpoint(value: unknown) {
  const raw = string(value, 'endpoint', 2048);
  if (
    value !== raw ||
    /\s/.test(raw) ||
    Array.from(raw).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw new BadRequestException('PUSH_ENDPOINT_INVALID');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BadRequestException('PUSH_ENDPOINT_INVALID');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    url.pathname === '/'
  )
    throw new BadRequestException('PUSH_ENDPOINT_INVALID');
  try {
    allowedHost(url.hostname, 'COMMUNICATION_WEB_PUSH_HOSTS');
  } catch {
    throw new BadRequestException('PUSH_ENDPOINT_INVALID');
  }
  return url;
}
export function pushKey(value: unknown, length: number) {
  if (
    typeof value !== 'string' ||
    value.length !== Math.ceil((length * 4) / 3) ||
    !/^[A-Za-z0-9_-]+$/.test(value) ||
    Buffer.from(value, 'base64url').length !== length ||
    Buffer.from(value, 'base64url').toString('base64url') !== value
  )
    throw new BadRequestException('PUSH_KEY_INVALID');
  if (length === 65) {
    try {
      if (Buffer.from(value, 'base64url')[0] !== 4) throw new Error();
      ECDH.convertKey(Buffer.from(value, 'base64url'), 'prime256v1');
    } catch {
      throw new BadRequestException('PUSH_KEY_INVALID');
    }
  }
  return value;
}
export function validateVapid(c: Variables, s?: Variables) {
  pushKey(c.publicKey, 65);
  if (!c.subject?.startsWith('mailto:'))
    throw new BadRequestException('VAPID_SUBJECT_INVALID');
  email(c.subject.slice(7));
  if (s) {
    pushKey(s.privateKey, 32);
    try {
      const key = createECDH('prime256v1');
      key.setPrivateKey(Buffer.from(s.privateKey, 'base64url'));
      if (key.getPublicKey().toString('base64url') !== c.publicKey)
        throw new Error();
    } catch {
      throw new BadRequestException('VAPID_PAIR_INVALID');
    }
  }
}
export function pushPayload(m: Message) {
  if (
    typeof m.title !== 'string' ||
    !m.title ||
    /[\r\n]/.test(m.title) ||
    m.title.length > 200 ||
    typeof m.text !== 'string'
  )
    throw new TransportFailure('PERMANENT');
  // Plain strings only. Frontend must use Notification title/body, never innerHTML.
  const payload = JSON.stringify({ version: 1, title: m.title, body: m.text });
  if (Buffer.byteLength(payload) > 3000)
    throw new TransportFailure('PERMANENT');
  return payload;
}
const publicSelect = {
  id: true,
  provider: true,
  platform: true,
  environment: true,
  label: true,
  active: true,
  expiresAt: true,
  revokedAt: true,
  createdAt: true,
  updatedAt: true,
  lastSeenAt: true,
  lastUsedAt: true,
} as const;
@Injectable()
export class GlobalPush implements Transport {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(SecretVault) private readonly vault: SecretVault,
  ) {}
  private async authorize(
    userId: string,
    companyId?: string,
    audience: PushRecipient['audience'] = 'COMPANY',
  ) {
    if (companyId !== undefined && !validCompanyId(companyId))
      throw new ForbiddenException('PUSH_SCOPE_INVALID');
    const user = await this.db.user.findFirst({
      where: { id: userId, isActive: true },
      select: { isSuperAdmin: true },
    });
    if (!user) throw new ForbiddenException('PUSH_RECIPIENT_UNAUTHORIZED');
    if (audience === 'ACCOUNT') {
      if (companyId) throw new ForbiddenException('PUSH_SCOPE_INVALID');
      return;
    }
    if (audience === 'ADMIN_TEST' || !companyId) {
      if (companyId || !user.isSuperAdmin)
        throw new ForbiddenException('PUSH_COMPANY_REQUIRED');
      return;
    }
    const member = await this.db.membership.findUnique({
      where: { userId_companyId: { userId, companyId } },
      select: {
        isActive: true,
        company: { select: { isActive: true, status: true } },
      },
    });
    if (
      !member?.isActive ||
      (!member.company.isActive &&
        !['SUSPENDED', 'CANCELED'].includes(member.company.status))
    )
      throw new ForbiddenException('PUSH_COMPANY_UNAUTHORIZED');
  }
  async publicConfiguration() {
    const row = await this.db.globalCommunicationProvider.findUnique({
      where: { provider: 'PUSH_PENDING' },
    });
    if (!row?.enabled || row.scope !== 'GLOBAL' || row.status !== 'CONNECTED')
      return {
        available: false,
        provider: 'WEB_PUSH',
        publicKey: null,
        environment: null,
        nativeAvailable: false,
      };
    const config = row.config as Variables;
    validateVapid(config);
    return {
      available: true,
      provider: 'WEB_PUSH',
      publicKey: config.publicKey,
      environment: row.environment,
      nativeAvailable: false,
    };
  }
  async register(userId: string, input: unknown, companyId?: string) {
    await this.authorize(userId, companyId);
    const d = object(input, [
      'provider',
      'platform',
      'endpoint',
      'keys',
      'expirationTime',
      'label',
    ]);
    if (
      (d.provider !== undefined && d.provider !== 'WEB_PUSH') ||
      (d.platform !== undefined &&
        !['WEB', 'ANDROID', 'IOS'].includes(d.platform as string))
    )
      throw new BadRequestException('PUSH_TRANSPORT_UNAVAILABLE');
    const config = await this.publicConfiguration();
    if (!config.available || !config.publicKey)
      throw new BadRequestException('PUSH_NOT_CONFIGURED');
    const endpoint = pushEndpoint(d.endpoint).href,
      keys = object(d.keys, ['p256dh', 'auth']);
    const p256dh = pushKey(keys.p256dh, 65),
      auth = pushKey(keys.auth, 16);
    let expiresAt: Date | null = null;
    if (d.expirationTime !== undefined && d.expirationTime !== null) {
      if (
        typeof d.expirationTime !== 'number' ||
        !Number.isSafeInteger(d.expirationTime) ||
        d.expirationTime <= Date.now() ||
        d.expirationTime > 8640000000000000
      )
        throw new BadRequestException('PUSH_EXPIRATION_INVALID');
      expiresAt = new Date(d.expirationTime);
    }
    const label = d.label === undefined ? null : string(d.label, 'label', 80);
    const endpointHash = createHash('sha256').update(endpoint).digest('hex');
    try {
      return await this.db.$transaction(
        async (tx) => {
          const old = await tx.globalPushSubscription.findUnique({
            where: { endpointHash },
          });
          if (old && (old.userId !== userId || old.scope !== 'GLOBAL'))
            throw new ConflictException('PUSH_ENDPOINT_UNAVAILABLE');
          if (old && old.environment !== config.environment)
            throw new ConflictException('PUSH_ENVIRONMENT_CHANGED');
          if (
            !(
              old?.active &&
              !old.revokedAt &&
              (!old.expiresAt || old.expiresAt > new Date())
            ) &&
            (await tx.globalPushSubscription.count({
              where: {
                ...activeDevices(userId),
              },
            })) >= 20
          )
            throw new BadRequestException('PUSH_DEVICE_LIMIT');
          const id = old?.id ?? randomUUID();
          const data = {
            credentialsEncrypted: this.vault.encrypt(
              JSON.stringify({ endpoint, keys: { p256dh, auth } }),
              pushScope(id),
            ),
            vapidPublicKey: config.publicKey!,
            environment: config.environment as GatewayEnvironment,
            platform: (d.platform ?? 'WEB') as 'WEB' | 'ANDROID' | 'IOS',
            label,
            expiresAt,
            active: true,
            revokedAt: null,
            lastSeenAt: new Date(),
          };
          const device = await tx.globalPushSubscription.upsert({
            where: { endpointHash },
            create: { id, userId, endpointHash, ...data },
            update: data,
            select: publicSelect,
          });
          if (companyId)
            await tx.globalPushAuthorization.upsert({
              where: {
                subscriptionId_companyId: { subscriptionId: id, companyId },
              },
              create: { subscriptionId: id, userId, companyId },
              update: { active: true, revokedAt: null },
            });
          return device;
        },
        { isolationLevel: 'Serializable' },
      );
    } catch (error) {
      // Serializable conflicts/unique races are recoverable by repeating the same registration.
      if (['P2034', 'P2002'].includes((error as { code?: string }).code ?? ''))
        throw new ConflictException('PUSH_REGISTRATION_CONFLICT');
      if (
        error instanceof BadRequestException ||
        error instanceof ConflictException
      )
        throw error;
      throw new ServiceUnavailableException('PUSH_REGISTRATION_UNAVAILABLE');
    }
  }
  async list(userId: string, companyId?: string) {
    await this.authorize(userId, companyId);
    return this.db.globalPushSubscription.findMany({
      where: {
        userId,
        scope: 'GLOBAL',
        ...(companyId
          ? { authorizations: { some: { companyId, userId } } }
          : {}),
      },
      select: {
        ...publicSelect,
        ...(companyId
          ? {
              authorizations: {
                where: { companyId, userId },
                select: { active: true, revokedAt: true },
              },
            }
          : {}),
      },
      take: 100,
      orderBy: { createdAt: 'desc' },
    });
  }
  async revoke(userId: string, id: string, companyId?: string) {
    await this.authorize(userId, companyId);
    await this.db.globalPushSubscription.updateMany({
      where: {
        id,
        userId,
        scope: 'GLOBAL',
        ...(companyId
          ? { authorizations: { some: { companyId, userId } } }
          : {}),
      },
      data: {
        active: false,
        revokedAt: new Date(),
        credentialsEncrypted: null,
      },
    });
    return { revoked: true };
  }
  async setActive(
    userId: string,
    id: string,
    input: unknown,
    companyId?: string,
  ) {
    await this.authorize(userId, companyId);
    const d = object(input, ['active']);
    boolean(d.active, 'active');
    if (typeof d.active !== 'boolean')
      throw new BadRequestException('PUSH_ACTIVE_REQUIRED');
    const active = d.active;
    try {
      await this.db.$transaction(
        async (tx) => {
          const device = await tx.globalPushSubscription.findFirst({
            where: {
              id,
              userId,
              scope: 'GLOBAL',
              credentialsEncrypted: { not: null },
              revokedAt: null,
              provider: 'WEB_PUSH',
              ...(companyId
                ? { authorizations: { some: { companyId, userId } } }
                : {}),
              OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
            },
          });
          if (!device) throw new BadRequestException('PUSH_DEVICE_UNAVAILABLE');
          if (
            !companyId &&
            active &&
            !device.active &&
            (await tx.globalPushSubscription.count({
              where: activeDevices(userId),
            })) >= 20
          )
            throw new BadRequestException('PUSH_DEVICE_LIMIT');
          if (companyId) {
            await tx.globalPushAuthorization.updateMany({
              where: { subscriptionId: id, userId, companyId },
              data: {
                active,
                revokedAt: active ? null : new Date(),
              },
            });
          } else {
            await tx.globalPushSubscription.updateMany({
              where: {
                id,
                userId,
                credentialsEncrypted: device.credentialsEncrypted,
                revokedAt: null,
              },
              data: { active },
            });
          }
        },
        { isolationLevel: 'Serializable' },
      );
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      if (['P2034', 'P2002'].includes((error as { code?: string }).code ?? ''))
        throw new ConflictException('PUSH_ACTIVATION_CONFLICT');
      throw new ServiceUnavailableException('PUSH_ACTIVATION_UNAVAILABLE');
    }
    return { updated: true };
  }
  async verify(c: Variables, s: Variables) {
    validateVapid(c, s);
  }
  private async invalidate(id: string, credentialsEncrypted: string) {
    await this.db.globalPushSubscription.updateMany({
      where: {
        id,
        scope: 'GLOBAL',
        provider: 'WEB_PUSH',
        credentialsEncrypted,
      },
      data: {
        active: false,
        revokedAt: new Date(),
        credentialsEncrypted: null,
      },
    });
  }
  async send(c: Variables, s: Variables, m: Message) {
    validateVapid(c, s);
    const payload = pushPayload(m);
    const recipient = m.pushRecipient;
    if (!recipient) throw new TransportFailure('RECIPIENT');
    const targets = pushTargets(recipient);
    try {
      await this.authorize(
        recipient.userId,
        recipient.companyId,
        recipient.audience,
      );
    } catch {
      throw new TransportFailure('RECIPIENT');
    }
    const row = await this.db.globalPushSubscription.findFirst({
      where: {
        ...targets,
        id: m.to,
      },
    });
    if (!row?.credentialsEncrypted || row.vapidPublicKey !== c.publicKey)
      throw new TransportFailure('RECIPIENT');
    let subscription: {
        endpoint: string;
        keys: { p256dh: string; auth: string };
      },
      url: URL;
    let decrypted: string;
    try {
      decrypted = this.vault.decrypt(
        row.credentialsEncrypted,
        pushScope(row.id),
      );
    } catch {
      throw new TransportFailure('PERMANENT');
    }
    try {
      const stored = object(JSON.parse(decrypted), ['endpoint', 'keys']);
      const keys = object(stored.keys, ['p256dh', 'auth']);
      subscription = {
        endpoint: string(stored.endpoint, 'endpoint', 2048),
        keys: {
          p256dh: pushKey(keys.p256dh, 65),
          auth: pushKey(keys.auth, 16),
        },
      };
    } catch {
      // Authenticated plaintext with malformed subscription structure is permanently unusable.
      await this.invalidate(row.id, row.credentialsEncrypted);
      throw new TransportFailure('RECIPIENT');
    }
    try {
      url = pushEndpoint(subscription.endpoint);
    } catch {
      // A changed host policy is not proof of an expired device.
      throw new TransportFailure('PERMANENT');
    }
    let details: ReturnType<typeof webpush.generateRequestDetails>;
    try {
      details = webpush.generateRequestDetails(subscription, payload, {
        vapidDetails: {
          subject: c.subject,
          publicKey: c.publicKey,
          privateKey: s.privateKey,
        },
        contentEncoding: 'aes128gcm',
        TTL: 300,
        urgency: 'normal',
      });
    } catch {
      throw new TransportFailure('PERMANENT');
    }
    // Use library cryptography and our pinned, allowlisted HTTP transport, rather than library unrestricted fetch.
    let result;
    try {
      result = await secureRequest(
        url,
        'POST',
        details.headers as Record<string, string>,
        details.body ?? undefined,
      );
    } catch (error) {
      if (error instanceof TransportFailure) throw error;
      throw new TransportFailure('UNCERTAIN');
    }
    if (result.status === 404 || result.status === 410) {
      await this.invalidate(row.id, row.credentialsEncrypted);
      throw new TransportFailure('RECIPIENT');
    }
    if (result.status < 200 || result.status >= 300)
      throw new TransportFailure(
        result.status === 429
          ? 'RATE_LIMIT'
          : result.status >= 500
            ? 'TRANSIENT'
            : result.status === 401 || result.status === 403
              ? 'AUTH'
              : 'PERMANENT',
      );
    try {
      await this.db.globalPushSubscription.updateMany({
        where: {
          id: row.id,
          credentialsEncrypted: row.credentialsEncrypted,
          active: true,
          revokedAt: null,
        },
        data: { lastUsedAt: new Date() },
      });
    } catch {
      throw new TransportFailure('UNCERTAIN');
    }
    return `webpush:${row.id}:${randomUUID()}`;
  }
  /** Internal bounded fanout. Business events must use CommunicationEngine for durable idempotency/retries. */
  async sendToUser(
    c: Variables,
    s: Variables,
    recipient: PushRecipient,
    message: Pick<Message, 'title' | 'text'>,
  ) {
    const targets = pushTargets(recipient);
    await this.authorize(
      recipient.userId,
      recipient.companyId,
      recipient.audience,
    );
    const devices = await this.db.globalPushSubscription.findMany({
      where: targets,
      select: { id: true },
      take: 20,
      orderBy: { id: 'asc' },
    });
    const result = {
      total: devices.length,
      accepted: 0,
      failed: 0,
      failures: {} as Partial<Record<TransportFailure['kind'], number>>,
    };
    for (const device of devices) {
      try {
        await this.send(c, s, {
          to: device.id,
          title: message.title,
          text: message.text,
          pushRecipient: recipient,
        });
        result.accepted++;
      } catch (error) {
        const kind =
          error instanceof TransportFailure ? error.kind : 'PERMANENT';
        result.failed++;
        result.failures[kind] = (result.failures[kind] ?? 0) + 1;
      }
    }
    return result;
  }
  async cleanup() {
    await this.db.globalPushSubscription.updateMany({
      where: {
        scope: 'GLOBAL',
        provider: 'WEB_PUSH',
        credentialsEncrypted: { not: null },
        expiresAt: { lte: new Date() },
      },
      data: {
        active: false,
        revokedAt: new Date(),
        credentialsEncrypted: null,
      },
    });
  }
}
