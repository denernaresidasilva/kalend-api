import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ECDH, createECDH, createHash, randomUUID } from 'node:crypto';
import webpush from 'web-push';
import { PrismaService } from '../prisma/prisma.service.js';
import { SecretVault } from '../billing/secret-vault.js';
import { object, string } from '../common/validation.js';
import { allowedHost } from './network.js';
import { secureRequest } from './secure-http.js';
import { email, TransportFailure } from './contracts.js';
import type { Message, Transport, Variables } from './contracts.js';

export const pushScope = (id: string) => `communication:GLOBAL:push:${id}`;
export function pushEndpoint(value: unknown) {
  const raw = string(value, 'endpoint', 2048);
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
    url.search ||
    url.pathname === '/'
  )
    throw new BadRequestException('PUSH_ENDPOINT_INVALID');
  allowedHost(url.hostname, 'COMMUNICATION_WEB_PUSH_HOSTS');
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
  label: true,
  active: true,
  expiresAt: true,
  revokedAt: true,
  createdAt: true,
  updatedAt: true,
  lastSeenAt: true,
} as const;
@Injectable()
export class GlobalPush implements Transport {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(SecretVault) private readonly vault: SecretVault,
  ) {}
  async publicConfiguration() {
    const row = await this.db.globalCommunicationProvider.findUnique({
      where: { provider: 'PUSH_PENDING' },
    });
    if (!row?.enabled || row.scope !== 'GLOBAL' || row.status !== 'CONNECTED')
      return {
        available: false,
        provider: 'WEB_PUSH',
        publicKey: null,
        nativeAvailable: false,
      };
    const config = row.config as Variables;
    validateVapid(config);
    return {
      available: true,
      provider: 'WEB_PUSH',
      publicKey: config.publicKey,
      nativeAvailable: false,
    };
  }
  async register(userId: string, input: unknown) {
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
      (d.platform !== undefined && d.platform !== 'WEB')
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
    return this.db.$transaction(
      async (tx) => {
        const old = await tx.globalPushSubscription.findUnique({
          where: { endpointHash },
        });
        if (old && old.userId !== userId)
          throw new ConflictException('PUSH_ENDPOINT_UNAVAILABLE');
        if (
          !old?.active &&
          (await tx.globalPushSubscription.count({
            where: { userId, active: true },
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
          label,
          expiresAt,
          active: true,
          revokedAt: null,
          lastSeenAt: new Date(),
        };
        return tx.globalPushSubscription.upsert({
          where: { endpointHash },
          create: { id, userId, endpointHash, ...data },
          update: data,
          select: publicSelect,
        });
      },
      { isolationLevel: 'Serializable' },
    );
  }
  list(userId: string) {
    return this.db.globalPushSubscription.findMany({
      where: { userId, scope: 'GLOBAL' },
      select: publicSelect,
      take: 100,
      orderBy: { createdAt: 'desc' },
    });
  }
  async revoke(userId: string, id: string) {
    await this.db.globalPushSubscription.updateMany({
      where: { id, userId, scope: 'GLOBAL' },
      data: {
        active: false,
        revokedAt: new Date(),
        credentialsEncrypted: null,
      },
    });
    return { revoked: true };
  }
  async verify(c: Variables, s: Variables) {
    validateVapid(c, s);
  }
  async send(c: Variables, s: Variables, m: Message) {
    validateVapid(c, s);
    const payload = pushPayload(m);
    const row = await this.db.globalPushSubscription.findFirst({
      where: {
        id: m.to,
        scope: 'GLOBAL',
        active: true,
        provider: 'WEB_PUSH',
        platform: 'WEB',
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    });
    if (!row?.credentialsEncrypted || row.vapidPublicKey !== c.publicKey)
      throw new TransportFailure('RECIPIENT');
    const subscription = JSON.parse(
      this.vault.decrypt(row.credentialsEncrypted, pushScope(row.id)),
    ) as { endpoint: string; keys: { p256dh: string; auth: string } };
    const url = pushEndpoint(subscription.endpoint);
    const details = webpush.generateRequestDetails(subscription, payload, {
      vapidDetails: {
        subject: c.subject,
        publicKey: c.publicKey,
        privateKey: s.privateKey,
      },
      contentEncoding: 'aes128gcm',
      TTL: 300,
      urgency: 'normal',
    });
    // Use library cryptography and our pinned, allowlisted HTTP transport, rather than library unrestricted fetch.
    const result = await secureRequest(
      url,
      'POST',
      details.headers as Record<string, string>,
      details.body ?? undefined,
    );
    if (result.status === 404 || result.status === 410) {
      await this.db.globalPushSubscription.updateMany({
        where: { id: row.id, credentialsEncrypted: row.credentialsEncrypted },
        data: {
          active: false,
          revokedAt: new Date(),
          credentialsEncrypted: null,
        },
      });
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
    return `webpush:${row.id}:${randomUUID()}`;
  }
  async cleanup() {
    await this.db.globalPushSubscription.updateMany({
      where: { active: true, expiresAt: { lte: new Date() } },
      data: {
        active: false,
        revokedAt: new Date(),
        credentialsEncrypted: null,
      },
    });
  }
}
