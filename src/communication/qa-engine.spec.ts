import { randomBytes } from 'node:crypto';
import { SecretVault } from '../billing/secret-vault.js';
import { CommunicationEngine } from './engine.js';
import { QA_COMMUNICATION_EVENT, qaBusinessKeyPrefix } from './qa-policy.js';

const companyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const idempotencyKey = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function qaFixture(overrides: { slug?: string; email?: string } = {}) {
  let outbox: Record<string, unknown> | null = null;
  const deliveries: Record<string, unknown>[] = [];
  const db = {
    company: {
      findUnique: vi.fn().mockResolvedValue({
        id: companyId,
        slug: overrides.slug ?? 'qa-communication-dev',
        name: 'QA Communication DEV',
        isActive: true,
      }),
    },
    membership: {
      findFirst: vi.fn().mockResolvedValue({
        user: {
          id: userId,
          name: 'QA User',
          email: overrides.email ?? 'qa@example.test',
          phone: '+15551234567',
        },
      }),
    },
    globalCommunicationProvider: {
      findUnique: vi.fn().mockResolvedValue({
        provider: 'SMTP',
        scope: 'GLOBAL',
        enabled: true,
        environment: 'SANDBOX',
        revision: 7,
      }),
    },
    globalCommunicationTemplate: {
      upsert: vi.fn().mockResolvedValue({ id: 'template-qa', revision: 1 }),
    },
    globalCommunicationOutbox: {
      findUnique: vi.fn(async () => outbox),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        outbox = { id: 'outbox-qa', ...data, deliveries: [] };
        return outbox;
      }),
    },
    globalCommunicationDelivery: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        deliveries.push(data);
        if (outbox) outbox.deliveries = [...deliveries];
        return data;
      }),
    },
    globalCommunicationLog: { create: vi.fn() },
  };
  const configuration = { resolveProvider: vi.fn().mockResolvedValue('SMTP') };
  const transports = { available: vi.fn().mockReturnValue(true) };
  const engine = new CommunicationEngine(
    db as never,
    new SecretVault(),
    configuration as never,
    transports as never,
  );
  return { engine, db, deliveries };
}

const env = {
  EVOLUTION_WEBHOOK_BASE_URL: 'https://api-dev.kalend.tech',
  DATABASE_URL: 'postgresql://qa:unused@localhost:5432/kalend_dev',
  QA_COMMUNICATION_ENABLED: 'true',
  QA_COMMUNICATION_COMPANY_ID: companyId,
  QA_COMMUNICATION_USER_ID: userId,
  QA_COMMUNICATION_ALLOWED_EMAIL: 'qa@example.test',
};

beforeEach(() => {
  vi.stubEnv('GATEWAY_ENCRYPTION_KEY', randomBytes(32).toString('hex'));
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
});
afterEach(() => vi.unstubAllEnvs());

describe('QA communication outbox', () => {
  it('creates one fixed QA intent and one delivery; repeating its key reuses both', async () => {
    const { engine, db, deliveries } = qaFixture();
    const input = { companyId, userId, channel: 'EMAIL', idempotencyKey };
    const first = await engine.createQaIntent(input, 'super-admin');
    const second = await engine.createQaIntent(input, 'super-admin');
    expect(first.event).toBe('QA_COMMUNICATION_TEST');
    expect(first.deliveries).toBe(1);
    expect(second.outboxId).toBe(first.outboxId);
    expect(deliveries).toHaveLength(1);
    expect(db.globalCommunicationTemplate.upsert).toHaveBeenCalledTimes(1);
    expect(db.globalCommunicationOutbox.create).toHaveBeenCalledTimes(1);
    expect(db.globalCommunicationDelivery.create).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(first)).not.toContain('qa@example.test');
  });

  it('rejects a non-QA tenant or a recipient outside the server allowlist', async () => {
    const tenant = qaFixture({ slug: 'ordinary-company' });
    await expect(
      tenant.engine.createQaIntent(
        { companyId, userId, channel: 'EMAIL', idempotencyKey },
        'super-admin',
      ),
    ).rejects.toThrow('QA_COMMUNICATION_TENANT_INVALID');
    const recipient = qaFixture({ email: 'other@example.test' });
    await expect(
      recipient.engine.createQaIntent(
        { companyId, userId, channel: 'EMAIL', idempotencyKey },
        'super-admin',
      ),
    ).rejects.toThrow('QA_RECIPIENT_NOT_ALLOWLISTED');
  });

  it('rejects production even with QA flags and allowlists supplied', async () => {
    vi.stubEnv('EVOLUTION_WEBHOOK_BASE_URL', 'https://api.kalend.tech');
    vi.stubEnv('DATABASE_URL', 'postgresql://qa:unused@localhost:5432/kalend');
    const { engine, db } = qaFixture();
    await expect(
      engine.createQaIntent(
        { companyId, userId, channel: 'EMAIL', idempotencyKey },
        'super-admin',
      ),
    ).rejects.toThrow('QA_COMMUNICATION_DISABLED');
    expect(db.globalCommunicationOutbox.create).not.toHaveBeenCalled();
  });

  it('qa-only worker selects only the allowlisted QA event and processes at most one item', async () => {
    const whereCalls: unknown[] = [];
    const db = {
      globalCommunicationDelivery: {
        findMany: vi.fn(async ({ where }: { where: unknown }) => {
          whereCalls.push(where);
          return [{ id: 'qa-delivery' }];
        }),
      },
    };
    const engine = new CommunicationEngine(
      db as never,
      new SecretVault(),
      {} as never,
      {} as never,
    );
    const processOne = vi.spyOn(engine, 'processOne').mockResolvedValue(true);
    const expand = vi.spyOn(engine, 'expand');
    const temporal = vi.spyOn(engine, 'temporal');
    await expect(engine.runQaOnly()).resolves.toEqual({
      qaOnly: true,
      eligible: 1,
      processed: 1,
    });
    expect((whereCalls[0] as { outbox: { event: string } }).outbox.event).toBe(
      'QA_COMMUNICATION_TEST',
    );
    expect(processOne).toHaveBeenCalledWith(true);
    expect(expand).not.toHaveBeenCalled();
    expect(temporal).not.toHaveBeenCalled();
    processOne.mockRestore();
    expand.mockRestore();
    temporal.mockRestore();
  });

  it.each([
    ['QA allowlisted address', 'qa@example.test', 'ACCEPTED', true],
    ['non-allowlisted address', 'other@example.test', 'SKIPPED', false],
  ] as const)(
    'revalidates %s immediately before provider send',
    async (_label, recipient, expectedStatus, shouldSend) => {
      const vault = new SecretVault();
      const delivery = {
        id: 'qa-delivery',
        outboxId: 'qa-outbox',
        userId,
        channel: 'EMAIL',
        provider: 'SMTP',
        environment: 'SANDBOX',
        configurationRevision: 7,
        templateId: 'qa-template',
        templateRevision: 1,
        targetKey: 'USER',
        status: 'PENDING',
        attempts: 0,
        payloadEncrypted: vault.encrypt(
          JSON.stringify({ to: 'qa@example.test', text: 'Harmless QA test' }),
          'communication:GLOBAL:delivery:qa-delivery',
        ),
      };
      const db = {
        globalCommunicationDelivery: {
          findMany: vi.fn().mockResolvedValue([{ ...delivery }]),
          updateMany: vi.fn(
            async ({
              where,
              data,
            }: {
              where: Record<string, unknown>;
              data: Record<string, unknown>;
            }) => {
              if (
                where.status !== delivery.status ||
                where.attempts !== delivery.attempts
              )
                return { count: 0 };
              Object.assign(delivery, data, {
                attempts:
                  typeof data.attempts === 'object'
                    ? delivery.attempts +
                      (data.attempts as { increment: number }).increment
                    : delivery.attempts,
              });
              return { count: 1 };
            },
          ),
        },
        globalCommunicationOutbox: {
          findUniqueOrThrow: vi.fn().mockResolvedValue({
            id: 'qa-outbox',
            event: QA_COMMUNICATION_EVENT,
            companyId,
            userId,
            businessKey: `${qaBusinessKeyPrefix(companyId)}${idempotencyKey}`,
          }),
        },
        membership: {
          findFirst: vi.fn().mockResolvedValue({
            user: {
              email: recipient,
              phone: '+15551234567',
              isSuperAdmin: false,
            },
            company: { slug: 'qa-communication-dev', isActive: true },
          }),
        },
        globalCommunicationTemplate: {
          findUnique: vi.fn().mockResolvedValue({
            enabled: true,
            event: QA_COMMUNICATION_EVENT,
            revision: 1,
          }),
        },
        globalCommunicationProvider: { updateMany: vi.fn() },
        globalCommunicationLog: { create: vi.fn() },
        $transaction: vi.fn(),
      };
      db.$transaction.mockImplementation(
        (callback: (tx: typeof db) => unknown) => callback(db),
      );
      const send = vi.fn().mockResolvedValue('mock-accepted-id');
      const context = vi.fn().mockResolvedValue({
        row: { environment: 'SANDBOX', revision: 7 },
        config: {},
        secret: {},
      });
      const engine = new CommunicationEngine(
        db as never,
        vault,
        { context } as never,
        { get: () => ({ send }) } as never,
      );
      await engine.processOne(true);
      expect(delivery.status).toBe(expectedStatus);
      expect(send).toHaveBeenCalledTimes(shouldSend ? 1 : 0);
      expect(context).toHaveBeenCalledTimes(shouldSend ? 1 : 0);
    },
  );
});
