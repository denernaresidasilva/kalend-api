import { randomBytes } from 'node:crypto';
import { SecretVault } from '../billing/secret-vault.js';
import { CommunicationEngine } from './engine.js';
import { QA_COMMUNICATION_EVENT } from './qa-policy.js';
import { communicationEventScope } from './event-scope.js';

const companyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherCompanyId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const idempotencyKey = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function qaFixture(overrides: { companyId?: string; email?: string; slug?: string } = {}) {
  let outbox: Record<string, unknown> | null = null;
  const deliveries: Record<string, unknown>[] = [];
  const db = {
    company: {
      findUnique: vi.fn().mockResolvedValue({
        id: overrides.companyId ?? companyId,
        slug: overrides.slug ?? 'any-reserved-name-is-irrelevant',
        name: 'QA Kalend',
        isActive: true,
      }),
    },
    membership: {
      findFirst: vi.fn().mockResolvedValue({
        user: {
          id: userId,
          name: 'QA User',
          email: overrides.email ?? 'qa@example.test',
          phone: '(12) 99601-5129',
        },
      }),
    },
    globalCommunicationProvider: {
      findUnique: vi.fn().mockResolvedValue({
        provider: 'SMTP', scope: 'GLOBAL', enabled: true,
        environment: 'SANDBOX', revision: 7,
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
    db as never, new SecretVault(), configuration as never, transports as never,
  );
  return { engine, db, deliveries };
}

const env = {
  EVOLUTION_WEBHOOK_BASE_URL: 'https://api-dev.kalend.tech',
  DATABASE_URL: 'postgresql://qa:unused@localhost:5432/kalend_dev',
  QA_COMMUNICATION_ENABLED: 'true',
  QA_COMMUNICATION_COMPANY_IDS: companyId,
  QA_COMMUNICATION_EMAIL_ALLOWLIST: 'qa@example.test',
  QA_COMMUNICATION_PHONE_ALLOWLIST: '+5512996015129',
};

beforeEach(() => {
  vi.stubEnv('GATEWAY_ENCRYPTION_KEY', randomBytes(32).toString('hex'));
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
});
afterEach(() => vi.unstubAllEnvs());

describe('QA communication intent', () => {
  it('creates one fixed QA intent and one delivery; repeating its key reuses both', async () => {
    const { engine, db, deliveries } = qaFixture();
    const input = { companyId, userId, channel: 'EMAIL', idempotencyKey };
    const first = await engine.createQaIntent(input, 'super-admin');
    const second = await engine.createQaIntent(input, 'super-admin');
    expect(first.event).toBe(QA_COMMUNICATION_EVENT);
    expect(first.deliveries).toBe(1);
    expect(second.outboxId).toBe(first.outboxId);
    expect(deliveries).toHaveLength(1);
    expect(db.globalCommunicationTemplate.upsert).toHaveBeenCalledTimes(1);
    expect(db.globalCommunicationOutbox.create).toHaveBeenCalledTimes(1);
    expect(db.globalCommunicationDelivery.create).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(first)).not.toContain('qa@example.test');
  });

  it('uses company IDs, not reserved slugs, and blocks a company outside the allowlist', async () => {
    const arbitrarySlug = qaFixture({ slug: 'qa-kalend' });
    await expect(arbitrarySlug.engine.createQaIntent(
      { companyId, userId, channel: 'EMAIL', idempotencyKey }, 'admin',
    )).resolves.toMatchObject({ event: QA_COMMUNICATION_EVENT });
    const wrongCompany = qaFixture({ companyId: otherCompanyId });
    await expect(wrongCompany.engine.createQaIntent(
      { companyId: otherCompanyId, userId, channel: 'EMAIL', idempotencyKey }, 'admin',
    )).rejects.toThrow('QA_COMMUNICATION_SCOPE_MISMATCH');
  });

  it('blocks a recipient not present in the backend allowlist', async () => {
    const { engine, db } = qaFixture({ email: 'other@example.test' });
    await expect(engine.createQaIntent(
      { companyId, userId, channel: 'EMAIL', idempotencyKey }, 'admin',
    )).rejects.toThrow('QA_RECIPIENT_NOT_ALLOWLISTED');
    expect(db.globalCommunicationOutbox.create).not.toHaveBeenCalled();
  });

  it('rejects production before creating an outbox row', async () => {
    vi.stubEnv('EVOLUTION_WEBHOOK_BASE_URL', 'https://api.kalend.tech');
    vi.stubEnv('DATABASE_URL', 'postgresql://qa:unused@localhost:5432/kalend');
    const { engine, db } = qaFixture();
    await expect(engine.createQaIntent(
      { companyId, userId, channel: 'EMAIL', idempotencyKey }, 'admin',
    )).rejects.toThrow('QA_COMMUNICATION_DISABLED');
    expect(db.globalCommunicationOutbox.create).not.toHaveBeenCalled();
  });
});

describe('QA commercial worker orchestration', () => {
  it('reports effective provider environments instead of raw historical labels', async () => {
    const configuration = {
      list: vi.fn().mockResolvedValue([
        { provider: 'SMTP', enabled: true, status: 'DEV_SANDBOX_CONFIGURED', environment: 'SANDBOX' },
        { provider: 'EVOLUTION', enabled: true, status: 'CONNECTED', environment: 'DEV' },
        { provider: 'PUSH_PENDING', enabled: true, status: 'CONNECTED', environment: 'SANDBOX' },
      ]),
      resolveProvider: vi.fn(async (channel: string) =>
        channel === 'EMAIL'
          ? 'SMTP'
          : channel === 'WHATSAPP'
            ? 'EVOLUTION'
            : 'PUSH_PENDING',
      ),
    };
    const db = {
      company: { findMany: vi.fn().mockResolvedValue([{ id: companyId, name: 'QA', isActive: true }]) },
      globalCommunicationOutbox: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
      globalCommunicationDelivery: { findMany: vi.fn().mockResolvedValue([]) },
      membership: { findMany: vi.fn().mockResolvedValue([]) },
      globalCommunicationTemplate: { findMany: vi.fn().mockResolvedValue([]) },
      companyCommunicationTemplate: { findMany: vi.fn().mockResolvedValue([]) },
      evolutionConnection: { findUnique: vi.fn().mockResolvedValue({ instanceName: 'kalend_dev_global', environment: 'DEV', status: 'CONNECTED', prepared: true }) },
      globalPushSubscription: { count: vi.fn().mockResolvedValue(0) },
    };
    const engine = new CommunicationEngine(db as never, new SecretVault(), configuration as never, {} as never);

    const result = await engine.qaPreflight(true);

    expect(configuration.list).toHaveBeenCalledOnce();
    expect(result.providers).toMatchObject({
      EMAIL: { environment: 'SANDBOX', status: 'DEV_SANDBOX_CONFIGURED' },
      WHATSAPP: { environment: 'DEV', status: 'CONNECTED' },
      PUSH: { environment: 'SANDBOX', status: 'CONNECTED' },
    });
    expect(result.evolution).toMatchObject({ instanceName: 'kalend_dev_global', environment: 'DEV', safeForQa: true });
  });

  it('scopes temporal, inbox, expansion and delivery claims to all authorized companies with bounded work', async () => {
    const db = { globalCommunicationDelivery: { updateMany: vi.fn() } };
    const engine = new CommunicationEngine(db as never, new SecretVault(), {} as never, {} as never);
    vi.spyOn(engine, 'qaPreflight').mockResolvedValue({ safeToRun: true } as never);
    const temporal = vi.spyOn(engine, 'temporal').mockResolvedValue({ inserted: 0 });
    const expand = vi.spyOn(engine, 'expand').mockResolvedValue(2);
    const processOne = vi.spyOn(engine, 'processOne')
      .mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false);
    const ingest = vi.fn().mockResolvedValue({ processed: 2, created: 2 });
    const result = await engine.runQaWorker(ingest);
    expect(temporal).toHaveBeenCalledWith({ companyIds: [companyId], limit: 5, qaMode: true });
    expect(ingest).toHaveBeenCalledWith({ companyIds: [companyId], limit: 5, qaMode: true });
    expect(expand).toHaveBeenCalledWith(expect.objectContaining({ companyIds: [companyId], maxEvents: 5, qaMode: true }));
    expect(processOne).toHaveBeenCalledWith({ qaMode: true });
    expect(result).toMatchObject({ mode: 'QA', expanded: 2, processed: 2, limits: { events: 5, deliveries: 20 } });
  });

  it('fails closed when preflight says the environment/company configuration is unsafe', async () => {
    const engine = new CommunicationEngine({} as never, new SecretVault(), {} as never, {} as never);
    vi.spyOn(engine, 'qaPreflight').mockResolvedValue({ safeToRun: false } as never);
    const temporal = vi.spyOn(engine, 'temporal');
    await expect(engine.runQaWorker(vi.fn())).rejects.toThrow('QA_WORKER_PREFLIGHT_BLOCKED');
    expect(temporal).not.toHaveBeenCalled();
  });

  it('claims deliveries only from allowlisted companies; the normal worker still excludes QA test intents', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const engine = new CommunicationEngine(
      { globalCommunicationDelivery: { findMany } } as never,
      new SecretVault(), {} as never, {} as never,
    );
    await engine.processOne({ qaMode: true });
    expect(findMany.mock.calls[0][0].where.outbox).toEqual(communicationEventScope(true).where);
    await engine.processOne();
    expect(findMany.mock.calls[1][0].where.outbox).toEqual(communicationEventScope().where);
  });

  it('adds the allowlist to the SQL expansion claim before SKIP LOCKED', async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    const db = { $transaction: vi.fn((callback: (tx: unknown) => unknown) => callback({ $queryRaw: queryRaw })) };
    const engine = new CommunicationEngine(db as never, new SecretVault(), {} as never, {} as never);
    await engine.expand({ companyIds: [companyId], maxEvents: 5, qaMode: true });
    const query = queryRaw.mock.calls[0][0] as { sql: string; values: unknown[] };
    expect(query.sql).toContain('"companyId" IN');
    expect(query.sql).toContain('LIMIT');
    expect(query.values).toContain(companyId);
    expect(query.values).toContain(5);
  });
});
