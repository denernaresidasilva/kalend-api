import { randomBytes } from 'node:crypto';
import { CommunicationEngine } from './engine.js';
import { SecretVault } from '../billing/secret-vault.js';
import { TransportFailure } from './contracts.js';
function fixture() {
  const vault = new SecretVault();
  const delivery = {
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
    globalCommunicationProvider: { updateMany: vi.fn() },
    globalCommunicationLog: { create: vi.fn() },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation((fn) => fn(db));
  const config = {
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
  return { engine, db, delivery, send, config };
}
beforeEach(() =>
  vi.stubEnv('GATEWAY_ENCRYPTION_KEY', randomBytes(32).toString('hex')),
);
afterEach(() => vi.unstubAllEnvs());
describe('outbox delivery and retries', () => {
  it('claims concurrent workers once and purges recipient/content after acceptance', async () => {
    const { engine, send, delivery } = fixture();
    await Promise.all([engine.processOne(), engine.processOne()]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(delivery.status).toBe('ACCEPTED');
    expect(delivery.attempts).toBe(1);
    expect(delivery.payloadEncrypted).toBeNull();
  });
  it.each([
    ['TRANSIENT', 'RETRY'],
    ['RATE_LIMIT', 'RETRY'],
    ['AUTH', 'FAILED'],
    ['PERMANENT', 'FAILED'],
    ['TEMPLATE', 'FAILED'],
    ['RECIPIENT', 'FAILED'],
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
  it('does not invoke any financial mutation when a provider fails', async () => {
    const { engine, send, db } = fixture();
    send.mockRejectedValue(new Error('provider token SECRET'));
    await expect(engine.processOne()).resolves.toBe(true);
    expect(db.globalCommunicationLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ code: 'COMMUNICATION_PERMANENT' }),
    });
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
            provider: 'SMTP',
            channel: 'EMAIL',
            content: { subject: 'Pagamento', text: '{{nome}} {{valor}}' },
          },
          {
            id: 'wa',
            revision: 1,
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
      { where: { event: 'PAYMENT_APPROVED', enabled: true } },
    );
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
            provider: 'GMAIL',
            channel: 'EMAIL',
            content: { subject: 'Pagamento', text: '{{valor}}' },
          },
          {
            id: 'push',
            revision: 1,
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
      ['GMAIL', 'USER', 'PENDING'],
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
