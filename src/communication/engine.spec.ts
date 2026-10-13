import { randomBytes } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import { CommunicationEngine } from './engine.js';
import { SecretVault } from '../billing/secret-vault.js';
import { TransportFailure } from './contracts.js';
function fixture() {
  const vault = new SecretVault();
  const delivery: {
    id: string;
    outboxId: string;
    userId: string;
    channel: string;
    provider: string;
    environment: string;
    configurationRevision: number;
    templateId: string;
    templateRevision: number;
    status: string;
    attempts: number;
    payloadEncrypted: string | null;
    providerMessageId?: string | null;
    nextAttemptAt?: Date | null;
    lastError?: string | null;
  } = {
    id: 'delivery',
    outboxId: 'event',
    userId: 'owner',
    channel: 'EMAIL',
    provider: 'SMTP',
    environment: 'SANDBOX',
    configurationRevision: 1,
    templateId: 'template',
    templateRevision: 1,
    status: 'PENDING',
    attempts: 0,
    payloadEncrypted: vault.encrypt(
      JSON.stringify({ to: 'owner@example.test', text: 'hello' }),
      'communication:GLOBAL:delivery:delivery',
    ),
  };
  const db = {
    globalCommunicationDelivery: {
      findMany: vi.fn(async () =>
        ['PENDING', 'RETRY'].includes(delivery.status) ? [{ ...delivery }] : [],
      ),
      updateMany: vi.fn(async ({ where, data }) => {
        if (!where.id) return { count: 0 };
        if (
          where.id &&
          (where.status !== delivery.status ||
            where.attempts !== delivery.attempts)
        )
          return { count: 0 };
        Object.assign(delivery, data, {
          attempts: data.attempts?.increment
            ? delivery.attempts + 1
            : delivery.attempts,
        });
        return { count: 1 };
      }),
    },
    globalCommunicationOutbox: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        id: 'event',
        companyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        event: 'PAYMENT_APPROVED',
      }),
    },
    membership: {
      findFirst: vi
        .fn()
        .mockResolvedValue({ user: { email: 'owner@example.test' } }),
    },
    globalCommunicationTemplate: {
      findUnique: vi.fn().mockResolvedValue({ enabled: true, revision: 1 }),
    },
    companyCommunicationTemplate: {
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
    },
    globalCommunicationProvider: { findUnique: vi.fn(), updateMany: vi.fn() },
    globalCommunicationLog: { create: vi.fn() },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation((fn) => fn(db));
  const config = {
    resolveProvider: vi.fn(async (channel: string): Promise<string | null> =>
      channel === 'EMAIL'
        ? 'SMTP'
        : channel === 'WHATSAPP'
          ? 'EVOLUTION'
          : 'PUSH_PENDING',
    ),
    context: vi.fn().mockResolvedValue({
      row: { environment: 'SANDBOX', revision: 1 },
      config: {},
      secret: { password: 'SECRET' },
    }),
  };
  const send = vi.fn().mockResolvedValue('message-id');
  const transports = { get: () => ({ send }), available: () => true };
  const engine = new CommunicationEngine(
    db as never,
    vault,
    config as never,
    transports as never,
  );
  return { engine, db, delivery, send, config, transports, vault };
}
beforeEach(() =>
  vi.stubEnv('GATEWAY_ENCRYPTION_KEY', randomBytes(32).toString('hex')),
);
afterEach(() => vi.unstubAllEnvs());
describe('outbox delivery and retries', () => {
  it('returns bounded worker outcomes for safe journal reporting', async () => {
    const { engine, db } = fixture();
    vi.spyOn(engine, 'expand').mockResolvedValue(3);
    let call = 0;
    vi.spyOn(engine, 'processOne').mockImplementation(async (options) => {
      const outcomes = ['ACCEPTED', 'RETRY', 'FAILED'] as const;
      if (call >= outcomes.length) return false;
      options.onResult?.(outcomes[call++]);
      return true;
    });

    await expect(engine.run()).resolves.toEqual({
      expanded: 3,
      processed: 3,
      recovered: 0,
      outcomes: { ACCEPTED: 1, SKIPPED: 0, RETRY: 1, FAILED: 1, UNCERTAIN: 0 },
    });
    expect(db.globalCommunicationDelivery.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: 'SENDING' }),
    }));
  });

  it('persists each GLOBAL event/channel independently and keeps provider state separate', async () => {
    const f = fixture();
    const records = new Map<string, Record<string, unknown>>();
    const upsert = vi.fn(async ({ where, create, update }: { where: { event_channel: { event: string; channel: string } }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
      const key = `${where.event_channel.event}:${where.event_channel.channel}`;
      const old = records.get(key);
      const next = old ? { ...old, ...update } : { id: key, revision: 1, ...create };
      records.set(key, next);
      return next;
    });
    Object.assign(f.db, { globalCommunicationTemplate: { upsert }, globalCommunicationLog: { create: vi.fn() } });
    f.transports.available = vi.fn().mockReturnValue(false);
    const save = (channel: 'EMAIL' | 'WHATSAPP' | 'PUSH', content: Record<string, string>) =>
      f.engine.template('OWNER_WELCOME', channel, { enabled: true, content }, 'admin');

    await save('EMAIL', { subject: 'Assunto inicial', text: 'Email {{nome}}' });
    await save('WHATSAPP', { text: 'WhatsApp {{nome}}' });
    await save('PUSH', { title: 'Push', text: 'Push {{nome}}' });
    await save('EMAIL', { subject: 'Assunto editado', text: 'Email atualizado {{nome}}' });

    expect(upsert).toHaveBeenCalledTimes(4);
    expect(records.size).toBe(3);
    expect(records.get('OWNER_WELCOME:EMAIL')).toMatchObject({ enabled: true, content: { subject: 'Assunto editado', text: 'Email atualizado {{nome}}' } });
    expect(records.get('OWNER_WELCOME:WHATSAPP')).toMatchObject({ enabled: true, content: { text: 'WhatsApp {{nome}}' } });
    expect(records.get('OWNER_WELCOME:PUSH')).toMatchObject({ enabled: true, content: { title: 'Push', text: 'Push {{nome}}' } });
  });

  it('claims concurrent workers once and purges recipient/content after acceptance', async () => {
    const { engine, send, delivery } = fixture();
    await Promise.all([engine.processOne(), engine.processOne()]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(delivery.status).toBe('ACCEPTED');
    expect(delivery.attempts).toBe(1);
    expect(delivery.providerMessageId).toBe('message-id');
    expect(delivery.payloadEncrypted).toBeNull();
  });
  it.each([
    ['TRANSIENT', 'RETRY'],
    ['RATE_LIMIT', 'RETRY'],
    ['AUTH', 'FAILED'],
    ['PERMANENT', 'FAILED'],
    ['TEMPLATE', 'FAILED'],
    ['RECIPIENT', 'FAILED'],
    ['CONFIGURATION', 'FAILED'],
    ['UNKNOWN', 'RETRY'],
    ['UNCERTAIN', 'UNCERTAIN'],
  ] as const)(
    'classifies %s as %s and sanitizes logs',
    async (kind, status) => {
      const { engine, send, delivery, db } = fixture();
      send.mockRejectedValue(new TransportFailure(kind));
      await engine.processOne();
      expect(delivery.status).toBe(status);
      expect(
        JSON.stringify(db.globalCommunicationLog.create.mock.calls),
      ).not.toContain('SECRET');
      expect(delivery.payloadEncrypted !== null).toBe(status === 'RETRY');
    },
  );
  it('stops on fifth attempt', async () => {
    const { engine, send, delivery } = fixture();
    delivery.attempts = 4;
    send.mockRejectedValue(new TransportFailure('TRANSIENT'));
    await engine.processOne();
    expect(delivery.status).toBe('FAILED');
    expect(delivery.attempts).toBe(5);
  });
  it('retries the same delivery after backoff and records provider acceptance', async () => {
    const { engine, send, delivery } = fixture();
    send.mockRejectedValueOnce(new TransportFailure('TRANSIENT'));
    send.mockResolvedValueOnce('accepted-message-id');
    await engine.processOne();
    expect(delivery.status).toBe('RETRY');
    expect(delivery.attempts).toBe(1);
    expect(delivery.nextAttemptAt).toBeInstanceOf(Date);
    expect(delivery.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    delivery.nextAttemptAt = new Date(0);
    await engine.processOne();
    expect(delivery.status).toBe('ACCEPTED');
    expect(delivery.attempts).toBe(2);
    expect(delivery.providerMessageId).toBe('accepted-message-id');
    expect(send).toHaveBeenCalledTimes(2);
  });
  it.each(['membership', 'template', 'configuration', 'recipient'])(
    'revalidates %s before sending',
    async (change) => {
      const { engine, send, db, config, delivery } = fixture();
      if (change === 'membership')
        db.membership.findFirst.mockResolvedValue(null);
      if (change === 'template')
        db.globalCommunicationTemplate.findUnique.mockResolvedValue({
          enabled: false,
          revision: 1,
        });
      if (change === 'configuration')
        config.context.mockResolvedValue({
          row: { environment: 'SANDBOX', revision: 2 },
          config: {},
          secret: { password: 'SECRET' },
        });
      if (change === 'recipient')
        db.membership.findFirst.mockResolvedValue({
          user: { email: 'new@example.test' },
        });
      await engine.processOne();
      expect(send).not.toHaveBeenCalled();
      expect(delivery.status).toBe('SKIPPED');
    },
  );
  it('rejects a poisoned event without scoped recipient', async () => {
    const { engine, send, db, delivery } = fixture();
    db.globalCommunicationOutbox.findUniqueOrThrow.mockResolvedValue({
      companyId: null,
      event: 'PAYMENT_APPROVED',
    });
    await engine.processOne();
    expect(send).not.toHaveBeenCalled();
    expect(delivery.status).toBe('FAILED');
  });
  it('retries a bounded unknown error and persists no raw provider exception', async () => {
    const { engine, send, db } = fixture();
    send.mockRejectedValue(new Error('provider token SECRET'));
    await expect(engine.processOne()).resolves.toBe(true);
    expect(db.globalCommunicationLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ code: 'COMMUNICATION_UNKNOWN', action: 'RETRY', attempt: 1 }),
    });
    expect(JSON.stringify(db.globalCommunicationLog.create.mock.calls)).not.toContain('SECRET');
  });
  it('does not retry a provider disabled or misconfigured after expansion', async () => {
    const { engine, send, db, delivery, config } = fixture();
    const configFailure = new ServiceUnavailableException('SMTP secret SECRET');
    config.context.mockRejectedValue(configFailure);
    await engine.processOne();
    expect(send).not.toHaveBeenCalled();
    expect(delivery.status).toBe('FAILED');
    expect(delivery.lastError).toBe('PROVIDER_UNAVAILABLE');
    expect(JSON.stringify(db.globalCommunicationLog.create.mock.calls)).not.toContain('SECRET');
  });
  it('does not resend after DB fails to persist external acceptance', async () => {
    const { engine, send, db, delivery } = fixture();
    db.$transaction.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(engine.processOne()).rejects.toThrow();
    expect(delivery.status).toBe('SENDING');
    expect(await engine.processOne()).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('does not allow manual retry of ambiguous delivery', async () => {
    const { engine, db } = fixture();
    db.globalCommunicationDelivery.updateMany.mockResolvedValue({ count: 0 });
    await expect(engine.reprocess('delivery', 'admin')).rejects.toThrow(
      'DELIVERY_NOT_SAFE_TO_RETRY',
    );
  });
  it('expands channels independently, deduplicates owner memberships, and records invalid phone separately', async () => {
    const { engine, db } = fixture();
    const additions = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'event' }]),
      globalCommunicationOutbox: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          companyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          event: 'PAYMENT_APPROVED',
          variables: { valor: '10 BRL' },
        }),
        update: vi.fn(),
      },
      globalCommunicationTemplate: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'email',
            revision: 1,
            enabled: true,
            provider: 'SMTP',
            channel: 'EMAIL',
            content: { subject: 'Pagamento', text: '{{nome}} {{valor}}' },
          },
          {
            id: 'wa',
            revision: 1,
            enabled: true,
            provider: 'EVOLUTION',
            channel: 'WHATSAPP',
            content: { text: '{{valor}}' },
          },
        ]),
      },
      membership: {
        findMany: vi.fn().mockResolvedValue([
          {
            userId: 'owner',
            user: { name: 'Owner', email: 'owner@example.test', phone: null },
            company: { name: 'Empresa' },
          },
          {
            userId: 'owner',
            user: { name: 'Owner', email: 'owner@example.test', phone: null },
            company: { name: 'Empresa' },
          },
        ]),
      },
      globalCommunicationProvider: {
        findUnique: vi.fn().mockResolvedValue({
          enabled: true,
          scope: 'GLOBAL',
          environment: 'SANDBOX',
          revision: 1,
        }),
      },
    };
    Object.assign(db, additions);
    const createMany = vi.fn();
    Object.assign(db.globalCommunicationDelivery, { createMany });
    await engine.expand();
    expect(createMany).toHaveBeenCalledTimes(2);
    expect(createMany.mock.calls.map(([arg]) => arg.data[0].status)).toEqual([
      'PENDING',
      'UNSENDABLE',
    ]);
    expect(additions.membership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          companyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          role: 'OWNER',
          isActive: true,
        }),
      }),
    );
    expect(additions.globalCommunicationTemplate.findMany).toHaveBeenCalledWith(
      { where: { event: 'PAYMENT_APPROVED', scope: 'GLOBAL' } },
    );
  });

  it.each([
    ['OWNER_WELCOME', '12996015129'],
    ['OWNER_WELCOME', '5512996015129'],
    ['OWNER_WELCOME', '+5512996015129'],
    ['OWNER_WELCOME', '(12) 99601-5129'],
    ['TRIAL_STARTED', '12996015129'],
    ['TRIAL_STARTED', '5512996015129'],
    ['TRIAL_STARTED', '+5512996015129'],
    ['TRIAL_STARTED', '(12) 99601-5129'],
  ] as const)('%s expands a legacy Brazilian phone (%s) for commercial WhatsApp', async (eventName, rawPhone) => {
    const f = fixture();
    const outboxId = `outbox-${eventName}`;
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    Object.assign(f.db, {
      $queryRaw: vi.fn().mockResolvedValue([{ id: outboxId }]),
      globalCommunicationOutbox: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: outboxId,
          companyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          userId: eventName === 'OWNER_WELCOME' ? 'owner' : null,
          event: eventName,
          variables: {},
        }),
        update: vi.fn(),
      },
      globalCommunicationTemplate: {
        findMany: vi.fn().mockResolvedValue([{
          id: `template-${eventName}`,
          revision: 1,
          enabled: true,
          provider: 'EVOLUTION',
          channel: 'WHATSAPP',
          content: { text: 'Olá, {{nome}} da {{empresa}}' },
        }]),
      },
      companyCommunicationTemplate: { findMany: vi.fn().mockResolvedValue([]) },
      membership: {
        findMany: vi.fn().mockResolvedValue([{
          userId: 'owner',
          user: { name: 'Owner QA', email: 'owner@example.test', phone: rawPhone },
          company: { name: 'QA' },
        }]),
      },
      globalCommunicationProvider: {
        findUnique: vi.fn().mockResolvedValue({
          enabled: true, scope: 'GLOBAL', environment: 'PRODUCTION', revision: 1,
        }),
      },
    });
    Object.assign(f.db.globalCommunicationDelivery, { createMany });
    f.config.resolveProvider.mockResolvedValue('EVOLUTION');

    await f.engine.expand();

    expect(createMany).toHaveBeenCalledTimes(1);
    const row = createMany.mock.calls[0][0].data[0];
    expect(row).toMatchObject({
      channel: 'WHATSAPP',
      status: 'PENDING',
      recipientMasked: '***5129',
      lastError: null,
    });
    expect(JSON.parse(f.vault.decrypt(
      row.payloadEncrypted,
      `communication:GLOBAL:delivery:${row.id}`,
    ))).toMatchObject({ to: '+5512996015129' });
  });

  it.each([[''], ['invalid'], ['+55+55 12 99601-5129']])(
    'keeps empty or invalid commercial WhatsApp recipient unsendable (%s)',
    async (rawPhone) => {
      const f = fixture();
      const createMany = vi.fn().mockResolvedValue({ count: 1 });
      Object.assign(f.db, {
        $queryRaw: vi.fn().mockResolvedValue([{ id: 'bad-phone-event' }]),
        globalCommunicationOutbox: {
          findUniqueOrThrow: vi.fn().mockResolvedValue({
            id: 'bad-phone-event', companyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            event: 'OWNER_WELCOME', variables: {},
          }),
          update: vi.fn(),
        },
        globalCommunicationTemplate: {
          findMany: vi.fn().mockResolvedValue([{
            id: 'valid-template', revision: 1, enabled: true, provider: 'EVOLUTION',
            channel: 'WHATSAPP', content: { text: 'Olá, {{nome}}' },
          }]),
        },
        companyCommunicationTemplate: { findMany: vi.fn().mockResolvedValue([]) },
        membership: {
          findMany: vi.fn().mockResolvedValue([{
            userId: 'owner', user: { name: 'Owner', email: 'owner@example.test', phone: rawPhone },
            company: { name: 'QA' },
          }]),
        },
        globalCommunicationProvider: {
          findUnique: vi.fn().mockResolvedValue({ enabled: true, scope: 'GLOBAL', revision: 1 }),
        },
      });
      Object.assign(f.db.globalCommunicationDelivery, { createMany });
      f.config.resolveProvider.mockResolvedValue('EVOLUTION');

      await f.engine.expand();

      expect(createMany.mock.calls[0][0].data[0]).toMatchObject({
        status: 'UNSENDABLE', recipientMasked: 'unavailable',
        lastError: 'RECIPIENT_OR_TEMPLATE_INVALID', payloadEncrypted: null,
      });
    },
  );

  it('does not create a WhatsApp delivery when neither COMPANY nor GLOBAL template exists', async () => {
    const f = fixture();
    const createMany = vi.fn();
    Object.assign(f.db, {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'missing-template-event' }]),
      globalCommunicationOutbox: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: 'missing-template-event', companyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          event: 'OWNER_WELCOME', variables: {},
        }),
        update: vi.fn(),
      },
      globalCommunicationTemplate: { findMany: vi.fn().mockResolvedValue([]) },
      companyCommunicationTemplate: { findMany: vi.fn().mockResolvedValue([]) },
      membership: { findMany: vi.fn().mockResolvedValue([{
        userId: 'owner', user: { name: 'Owner', email: 'owner@example.test', phone: '12996015129' },
        company: { name: 'QA' },
      }]) },
      globalCommunicationDelivery: { createMany: createMany },
    });

    await f.engine.expand();

    expect(createMany).not.toHaveBeenCalled();
    expect(f.config.resolveProvider).not.toHaveBeenCalled();
  });

  it('revalidates a legacy commercial phone with the central normalizer before sending', async () => {
    const f = fixture();
    f.delivery.channel = 'WHATSAPP';
    f.delivery.provider = 'EVOLUTION';
    f.delivery.payloadEncrypted = f.vault.encrypt(
      JSON.stringify({ to: '+5512996015129', text: 'Olá' }),
      'communication:GLOBAL:delivery:delivery',
    );
    f.db.globalCommunicationOutbox.findUniqueOrThrow.mockResolvedValue({
      id: 'event', companyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', event: 'TRIAL_STARTED',
    });
    f.db.membership.findFirst.mockResolvedValue({
      user: { email: 'owner@example.test', phone: '12 99601-5129', isSuperAdmin: false },
      company: { isActive: true },
    });

    await expect(f.engine.processOne()).resolves.toBe(true);

    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0][2]).toMatchObject({
      to: '+5512996015129', globalRecipientUserId: 'owner',
    });
    expect(f.delivery.status).toBe('ACCEPTED');
  });

  it.each([
    ['no company override falls back to GLOBAL', [], 'global-template', 'GLOBAL'],
    ['active company override wins', [{ id: 'company-template', revision: 2, channel: 'EMAIL', enabled: true, content: { subject: 'Company', text: 'custom' } }], 'company-template', 'COMPANY'],
    ['disabled company override blocks GLOBAL fallback', [{ id: 'company-disabled', revision: 3, channel: 'EMAIL', enabled: false, content: { subject: 'Company', text: 'custom' } }], null, null],
  ] as const)('%s', async (_label, companyRows, expectedTemplateId, expectedScope) => {
    const f = fixture();
    const outboxId = 'company-template-outbox';
    const createMany = vi.fn();
    Object.assign(f.db, {
      $queryRaw: vi.fn().mockResolvedValue([{ id: outboxId }]),
      globalCommunicationOutbox: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: outboxId,
          companyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          event: 'PAYMENT_APPROVED',
          variables: { valor: '10 BRL' },
          expandedAt: null,
          lastError: null,
        }),
        update: vi.fn(),
      },
      globalCommunicationTemplate: {
        findMany: vi.fn().mockResolvedValue([{
          id: 'global-template', revision: 1, provider: 'SMTP', channel: 'EMAIL', enabled: true,
          content: { subject: 'Global', text: 'global' },
        }]),
      },
      companyCommunicationTemplate: {
        findMany: vi.fn().mockResolvedValue(companyRows),
        findUnique: vi.fn(),
      },
      membership: {
        findMany: vi.fn().mockResolvedValue([{
          userId: 'owner',
          user: { name: 'Owner', email: 'owner@example.test', phone: null },
          company: { name: 'Empresa' },
        }]),
      },
      globalCommunicationProvider: {
        findUnique: vi.fn().mockResolvedValue({ enabled: true, scope: 'GLOBAL', environment: 'SANDBOX', revision: 1 }),
      },
      globalCommunicationDelivery: { createMany },
    });
    f.config.resolveProvider.mockResolvedValue('SMTP');

    await f.engine.expand();

    if (expectedTemplateId) {
      expect(createMany).toHaveBeenCalledTimes(1);
      expect(createMany.mock.calls[0][0].data[0]).toMatchObject({
        templateId: expectedTemplateId,
        templateScope: expectedScope,
      });
    } else expect(createMany).not.toHaveBeenCalled();
    expect(f.db.companyCommunicationTemplate.findMany).toHaveBeenCalledWith({
      where: { companyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', event: 'PAYMENT_APPROVED' },
    });
  });

  it('keeps provider-missing outbox recoverable and expands it once configuration returns', async () => {
    const f = fixture();
    const outbox = {
      id: 'outbox-no-provider',
      event: 'PAYMENT_APPROVED',
      companyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      variables: { valor: '10 BRL' },
      expandedAt: null as Date | null,
      lastError: null as string | null,
    };
    const createMany = vi.fn();
    const outboxUpdate = vi.fn(async ({ data }) => Object.assign(outbox, data));
    const outboxLog = vi.fn();
    Object.assign(f.db, {
      $queryRaw: vi.fn(async () => (outbox.expandedAt ? [] : [{ id: outbox.id }])),
      globalCommunicationOutbox: {
        findUniqueOrThrow: vi.fn(async () => ({ ...outbox })),
        update: outboxUpdate,
      },
      globalCommunicationTemplate: {
        findMany: vi.fn(async () => [{
          id: 'email-template', revision: 1, enabled: true, provider: 'SMTP', channel: 'EMAIL',
          content: { subject: 'Pagamento', text: '{{valor}}' },
        }]),
      },
      membership: {
        findMany: vi.fn(async () => [{
          userId: 'owner', user: { name: 'Owner', email: 'owner@example.test' },
          company: { name: 'Empresa QA' },
        }]),
      },
      globalCommunicationProvider: { findUnique: vi.fn(async () => null) },
      globalCommunicationDelivery: { createMany },
      globalCommunicationLog: { create: outboxLog },
    });
    f.config.resolveProvider.mockResolvedValue(null);

    await f.engine.expand();

    expect(outbox.expandedAt).toBeNull();
    expect(outbox.lastError).toBe('NO_ACTIVE_PROVIDER');
    expect(createMany).not.toHaveBeenCalled();
    expect(outboxLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        outboxId: outbox.id,
        action: 'OUTBOX_BLOCKED_EMAIL',
        code: 'NO_ACTIVE_PROVIDER',
      }),
    });

    // The same business event remains pending and is expanded once the provider returns.
    (f.db.globalCommunicationProvider.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ scope: 'GLOBAL', enabled: true, environment: 'SANDBOX', revision: 1 });
    f.config.resolveProvider.mockResolvedValue('SMTP');
    await f.engine.expand();
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany.mock.calls[0][0].data[0]).toMatchObject({
      outboxId: outbox.id,
      userId: 'owner',
      channel: 'EMAIL',
      status: 'PENDING',
      provider: 'SMTP',
    });
    expect(outbox.expandedAt).toBeInstanceOf(Date);
    expect(outbox.lastError).toBeNull();
    expect(outboxLog).toHaveBeenCalledWith({
      data: expect.objectContaining({ outboxId: outbox.id, action: 'OUTBOX_EXPANDED' }),
    });
    await f.engine.expand();
    expect(createMany).toHaveBeenCalledTimes(1);
  });

  it('records a disabled GLOBAL provider as a blocked configuration, without creating a delivery', async () => {
    const f = fixture();
    const outbox = { id: 'disabled', event: 'PAYMENT_APPROVED', companyId: 'company', variables: {}, expandedAt: null, lastError: null };
    const createMany = vi.fn();
    const log = vi.fn();
    Object.assign(f.db, {
      $queryRaw: vi.fn().mockResolvedValue([{ id: outbox.id }]),
      globalCommunicationOutbox: { findUniqueOrThrow: vi.fn().mockImplementation(async () => ({ ...outbox })), update: vi.fn(async ({ data }) => Object.assign(outbox, data)) },
      globalCommunicationTemplate: { findMany: vi.fn().mockResolvedValue([{ id: 'template', revision: 1, enabled: true, provider: 'SMTP', channel: 'EMAIL', content: {} }]) },
      membership: { findMany: vi.fn().mockResolvedValue([{ userId: 'owner', user: { name: 'Owner', email: 'owner@example.test' }, company: { name: 'QA' } }]) },
      globalCommunicationProvider: { findUnique: vi.fn().mockResolvedValue({ scope: 'GLOBAL', enabled: false }) },
      globalCommunicationDelivery: { createMany },
      globalCommunicationLog: { create: log },
    });
    f.config.resolveProvider.mockResolvedValue(null);
    await f.engine.expand();
    expect(outbox.expandedAt).toBeNull();
    expect(outbox.lastError).toBe('PROVIDER_DISABLED');
    expect(createMany).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith({ data: expect.objectContaining({ code: 'PROVIDER_DISABLED' }) });
  });
  it('lists blocked outbox rows without returning event variables', async () => {
    const { engine, db } = fixture();
    const findMany = vi.fn().mockResolvedValue([]);
    Object.assign(db, { globalCommunicationOutbox: { findMany } });
    await engine.listOutboxFailures({ limit: '25', offset: '10' });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { scope: 'GLOBAL', expandedAt: null, lastError: { not: null } },
      select: expect.objectContaining({ id: true, event: true, lastError: true }),
      take: 25,
      skip: 10,
    }));
    expect(JSON.stringify(findMany.mock.calls)).not.toContain('variables');
  });
});

describe('Phase 3 shares the existing outbox motor', () => {
  it('fans out independently per global Web Push device, leaves EMAIL/WHATSAPP deduplication compatible', async () => {
    const f = fixture();
    const createMany = vi.fn();
    Object.assign(f.db, {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'event' }]),
      globalCommunicationOutbox: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          companyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          event: 'PAYMENT_APPROVED',
          variables: { valor: '10 BRL' },
        }),
        update: vi.fn(),
      },
      globalCommunicationTemplate: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'email',
            revision: 1,
            enabled: true,
            provider: 'GMAIL',
            channel: 'EMAIL',
            content: { subject: 'Pagamento', text: '{{valor}}' },
          },
          {
            id: 'push',
            revision: 1,
            enabled: true,
            provider: 'PUSH_PENDING',
            channel: 'PUSH',
            content: { title: 'Kalend', text: '{{valor}}' },
          },
        ]),
      },
      membership: {
        findMany: vi.fn().mockResolvedValue([
          {
            userId: 'owner',
            user: { name: 'Owner', email: 'owner@example.test' },
            company: { name: 'Empresa' },
          },
        ]),
      },
      globalPushSubscription: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: 'device1' }, { id: 'device2' }]),
      },
      globalCommunicationProvider: {
        findUnique: vi.fn().mockResolvedValue({
          enabled: true,
          scope: 'GLOBAL',
          environment: 'SANDBOX',
          revision: 1,
        }),
      },
    });
    Object.assign(f.db.globalCommunicationDelivery, { createMany });
    await f.engine.expand();
    expect(
      createMany.mock.calls.map(([arg]) => [
        arg.data[0].provider,
        arg.data[0].targetKey,
        arg.data[0].status,
      ]),
    ).toEqual([
      ['SMTP', 'USER', 'PENDING'],
      ['PUSH_PENDING', 'device1', 'PENDING'],
      ['PUSH_PENDING', 'device2', 'PENDING'],
    ]);
    const devices = (f.db as any).globalPushSubscription;
    expect(devices.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'owner',
          scope: 'GLOBAL',
          active: true,
          provider: 'WEB_PUSH',
          environment: 'SANDBOX',
          authorizations: expect.objectContaining({
            some: expect.objectContaining({
              companyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              userId: 'owner',
              active: true,
            }),
          }),
        }),
      }),
    );
  });
  it.each(['success', 'rate', 'transient', 'uncertain', 'revoked', 'hijacked'])(
    'processes Push %s using delivery/failure/log and bounded retries',
    async (condition) => {
      const f = fixture();
      Object.assign(f.delivery, {
        channel: 'PUSH',
        provider: 'PUSH_PENDING',
        targetKey: 'device1',
        payloadEncrypted: new SecretVault().encrypt(
          JSON.stringify({ to: 'device1', title: 'Kalend', text: 'Pagamento' }),
          'communication:GLOBAL:delivery:delivery',
        ),
      });
      const findFirst = vi
        .fn()
        .mockResolvedValue(
          condition === 'revoked' || condition === 'hijacked'
            ? null
            : { id: 'device1' },
        );
      Object.assign(f.db, { globalPushSubscription: { findFirst } });
      if (condition === 'rate')
        f.send.mockRejectedValue(new TransportFailure('RATE_LIMIT'));
      if (condition === 'transient')
        f.send.mockRejectedValue(new TransportFailure('TRANSIENT'));
      if (condition === 'uncertain')
        f.send.mockRejectedValue(new TransportFailure('UNCERTAIN'));
      await f.engine.processOne();
      expect(f.delivery.status).toBe(
        condition === 'rate' || condition === 'transient'
          ? 'RETRY'
          : condition === 'uncertain'
            ? 'UNCERTAIN'
            : condition === 'revoked' || condition === 'hijacked'
              ? 'SKIPPED'
              : 'ACCEPTED',
      );
      expect(findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'device1',
            userId: 'owner',
            scope: 'GLOBAL',
          }),
        }),
      );
      expect(f.db.globalCommunicationLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          deliveryId: 'delivery',
          action: f.delivery.status,
          attempt: 1,
        }),
      });
      expect(f.send).toHaveBeenCalledTimes(
        condition === 'revoked' || condition === 'hijacked' ? 0 : 1,
      );
    },
  );
  it('sends Gmail through the same worker and records acceptance', async () => {
    const f = fixture();
    Object.assign(f.delivery, { provider: 'GMAIL' });
    await f.engine.processOne();
    expect(f.delivery.status).toBe('ACCEPTED');
    expect(f.send).toHaveBeenCalledTimes(1);
  });
});
