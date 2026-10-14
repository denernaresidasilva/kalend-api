import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { QaSimulationService } from '../src/billing/qa-simulation.service.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';
import { CommunicationEngine } from '../src/communication/engine.js';
import { SecretVault } from '../src/billing/secret-vault.js';
import { TransportFailure } from '../src/communication/contracts.js';
import { communicationEventScope } from '../src/communication/event-scope.js';

describe('full worker QA isolation (ephemeral PostgreSQL, mocked transports)', () => {
  let db: PGlite, socket: PGLiteSocketServer, prisma: PrismaClient;
  let qa: string, commercial: string, outside: string, plan: string;
  let engine: CommunicationEngine, inbox: NotificationsService;
  const send = vi.fn(), network = vi.fn(() => { throw Error('Network forbidden'); });
  beforeAll(async () => {
    db = new PGlite();
    const migrations = new URL('../prisma/migrations/', import.meta.url);
    for (const name of (await readdir(migrations)).sort())
      if (name !== 'migration_lock.toml') await db.exec(await readFile(new URL(`${name}/migration.sql`, migrations), 'utf8'));
    socket = new PGLiteSocketServer({ db, host: '127.0.0.1', port: 0 }); await socket.start();
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: `postgresql://test:test@${socket.getServerConn()}/test`, max: 1 }) });
  }, 30000);
  beforeEach(async () => {
    await db.exec('TRUNCATE "Company", "User", "Plan", "GlobalCommunicationProvider", "GlobalCommunicationTemplate" CASCADE');
    qa = randomUUID(); commercial = randomUUID(); outside = randomUUID(); plan = randomUUID();
    for (const [key, value] of Object.entries({
      EVOLUTION_WEBHOOK_BASE_URL: 'https://api-dev.kalend.tech', BILLING_PUBLIC_API_URL: 'https://api-dev.kalend.tech',
      DATABASE_URL: 'postgresql://test:unused@localhost/kalend_dev', QA_COMMUNICATION_ENABLED: 'true',
      COMMERCIAL_QA_SIMULATION_ENABLED: 'true', COMMUNICATION_WORKER_ENABLED: 'true',
      COMMUNICATION_DEV_SMTP_SANDBOX_ENABLED: 'true', QA_COMMUNICATION_COMPANY_IDS: qa,
      QA_COMMUNICATION_EMAIL_ALLOWLIST: 'qa@example.test,commercial@example.test,outside@example.test',
      GATEWAY_ENCRYPTION_KEY: 'ab'.repeat(32),
    })) vi.stubEnv(key, value);
    vi.stubGlobal('fetch', network);
    await prisma.plan.create({ data: { id: plan, name: 'Fixture', code: plan, monthlyPriceCents: 9900 } });
    for (const [id, email] of [[qa, 'qa@example.test'], [commercial, 'commercial@example.test'], [outside, 'outside@example.test']]) {
      await prisma.company.create({ data: { id, slug: id, name: 'Name does not determine QA', status: 'ACTIVE' } });
      const user = await prisma.user.create({ data: { email, name: 'Owner', passwordHash: 'fixture' } });
      await prisma.membership.create({ data: { userId: user.id, companyId: id, role: 'OWNER' } });
    }
    const provider = await prisma.globalCommunicationProvider.create({ data: { provider: 'SMTP', enabled: true, environment: 'SANDBOX', config: {} } });
    await prisma.globalCommunicationTemplate.create({ data: { event: 'PAYMENT_PENDING', channel: 'EMAIL', provider: 'SMTP', enabled: true, content: { subject: 'Pending', text: '{{valor}}' } } });
    send.mockReset(); send.mockResolvedValue('mock-accepted');
    engine = new CommunicationEngine(prisma as never, new SecretVault(), {
      resolveProvider: vi.fn().mockResolvedValue('SMTP'), deliveryEnvironment: vi.fn().mockResolvedValue('SANDBOX'),
      context: vi.fn().mockResolvedValue({ row: provider, deliveryEnvironment: 'SANDBOX', config: {}, secret: {} }),
      list: vi.fn().mockResolvedValue([{ ...provider, status: 'DEV_SANDBOX_CONFIGURED' }]),
    } as never, { get: vi.fn().mockReturnValue({ send }) } as never);
    inbox = new NotificationsService(prisma as never);
  });
  afterEach(() => { expect(network).not.toHaveBeenCalled(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
  afterAll(async () => { await prisma?.$disconnect(); await socket?.stop(); await db?.close(); });
  async function pending() {
    return new QaSimulationService(prisma as never).simulateFromCli({ companyId: qa, action: 'PAYMENT_PENDING', planId: plan, billingInterval: 'MONTHLY', idempotencyKey: 'fresh' });
  }
  async function qaEvent() { return prisma.globalCommunicationOutbox.findFirstOrThrow({ where: { companyId: qa, event: 'PAYMENT_PENDING' } }); }
  it('normal worker leaves a fresh QA fact untouched; QA ingests, expands, sends and repeats idempotently while commercial still works', async () => {
    await pending();
    await prisma.payment.create({ data: { companyId: commercial, planId: plan, gateway: 'STRIPE', environment: 'SANDBOX', amountCents: 9900, status: 'PENDING', creationState: 'CREATED' } });
    const unauthorized = await prisma.globalCommunicationOutbox.create({ data: { companyId: outside, event: 'PAYMENT_PENDING', businessKey: `QA_SIMULATION:PAYMENT_PENDING:${randomUUID()}`, variables: { valor: '99' } } });
    const malformed = await prisma.globalCommunicationOutbox.create({ data: { companyId: commercial, event: 'PAYMENT_PENDING', businessKey: 'QA_SIMULATION-malformed', variables: {} } });
    const metadata = await prisma.globalCommunicationOutbox.create({ data: { companyId: outside, event: 'PAYMENT_PENDING', businessKey: 'legacy-metadata', variables: { source: 'QA_SIMULATION' } } });
    await engine.temporal(); await inbox.ingest(); await engine.run();
    expect(await qaEvent()).toMatchObject({ notificationProcessedAt: null, expandedAt: null });
    expect(await prisma.notification.count({ where: { companyId: qa, type: 'pagamento' } })).toBe(0);
    expect(await prisma.globalCommunicationDelivery.count({ where: { outbox: { companyId: qa } } })).toBe(0);
    const normal = await prisma.globalCommunicationOutbox.findFirstOrThrow({ where: { companyId: commercial, businessKey: { startsWith: 'PAYMENT_PENDING:' } } });
    expect(normal.notificationProcessedAt).not.toBeNull(); expect(normal.expandedAt).not.toBeNull();
    expect(await prisma.globalCommunicationDelivery.findFirst({ where: { outboxId: normal.id } })).toMatchObject({ status: 'ACCEPTED', attempts: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    const preflight = await engine.qaPreflight(); expect(preflight.safeToRun).toBe(true); expect(preflight.qaEventsPending.map(x => x.eventId)).toEqual([(await qaEvent()).id]);
    const result = await engine.runQaWorker(options => inbox.ingest(options));
    expect(result).toMatchObject({ expanded: 1, processed: 1 });
    expect(await qaEvent()).toMatchObject({ notificationProcessedAt: expect.any(Date), expandedAt: expect.any(Date) });
    expect(await prisma.notification.count({ where: { companyId: qa, type: 'pagamento' } })).toBe(1);
    expect(await prisma.globalCommunicationDelivery.findFirst({ where: { outbox: { companyId: qa } } })).toMatchObject({ status: 'ACCEPTED', attempts: 1 });
    expect(send).toHaveBeenCalledTimes(2);
    expect(await engine.runQaWorker(options => inbox.ingest(options))).toMatchObject({ expanded: 0, processed: 0, deliveriesCreated: 0 });
    expect(await prisma.payment.count({ where: { companyId: qa } })).toBe(1);
    expect(await prisma.globalCommunicationDelivery.count({ where: { outbox: { companyId: qa } } })).toBe(1);
    for (const event of [unauthorized, malformed, metadata]) expect(await prisma.globalCommunicationOutbox.findUnique({ where: { id: event.id } })).toMatchObject({ notificationProcessedAt: null, expandedAt: null });
    await expect(inbox.ingest({ qaMode: true, companyIds: [outside] })).rejects.toThrow('QA_COMMUNICATION_SCOPE_MISMATCH');
  });
  it('partial QA facts, retries and stale SENDING are untouched by normal recovery; QA owns retry/backoff and recovery', async () => {
    await pending(); await inbox.ingest({ qaMode: true }); await engine.expand({ qaMode: true });
    const delivery = await prisma.globalCommunicationDelivery.findFirstOrThrow({ where: { outbox: { companyId: qa } } });
    await prisma.globalCommunicationDelivery.update({ where: { id: delivery.id }, data: { status: 'RETRY', nextAttemptAt: new Date(0) } });
    const before = await prisma.globalCommunicationDelivery.findUnique({ where: { id: delivery.id } });
    await engine.run(); expect(await prisma.globalCommunicationDelivery.findUnique({ where: { id: delivery.id } })).toEqual(before);
    send.mockRejectedValueOnce(new TransportFailure('TRANSIENT'));
    await engine.processOne({ qaMode: true });
    const retry = await prisma.globalCommunicationDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(retry.status).toBe('RETRY'); expect(retry.attempts).toBe(1); expect(retry.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    await engine.run(); expect(await prisma.globalCommunicationDelivery.findUnique({ where: { id: delivery.id } })).toEqual(retry);
    await prisma.globalCommunicationDelivery.update({ where: { id: delivery.id }, data: { nextAttemptAt: new Date(0) } });
    await engine.processOne({ qaMode: true }); expect(await prisma.globalCommunicationDelivery.findUnique({ where: { id: delivery.id } })).toMatchObject({ status: 'ACCEPTED', attempts: 2 });
    await prisma.globalCommunicationDelivery.update({ where: { id: delivery.id }, data: { status: 'SENDING', startedAt: new Date(0) } });
    const sending = await prisma.globalCommunicationDelivery.findUnique({ where: { id: delivery.id } });
    await engine.run(); expect(await prisma.globalCommunicationDelivery.findUnique({ where: { id: delivery.id } })).toEqual(sending);
    await engine.runQaWorker(options => inbox.ingest(options));
    expect(await prisma.globalCommunicationDelivery.findUnique({ where: { id: delivery.id } })).toMatchObject({ status: 'UNCERTAIN', lastError: 'WORKER_INTERRUPTED' });
  });
  it('normal expansion ignores old partially ingested QA; temporal generation never manufactures QA events', async () => {
    await pending(); await inbox.ingest({ qaMode: true }); await engine.run();
    expect((await qaEvent()).expandedAt).toBeNull();
    await prisma.subscription.create({ data: { companyId: qa, planId: plan, gateway: 'QA_SIMULATION', environment: 'SANDBOX', status: 'TRIALING', trialEndsAt: new Date(Date.now() + 86400000) } });
    expect(await engine.temporal()).toEqual({ inserted: 0 }); expect(await engine.temporal({ qaMode: true })).toEqual({ inserted: 0 });
    expect(await prisma.globalCommunicationOutbox.count({ where: { event: 'TRIAL_EXPIRING' } })).toBe(0);
    await prisma.subscription.create({ data: { companyId: commercial, planId: plan, gateway: 'STRIPE', environment: 'SANDBOX', status: 'TRIALING', trialEndsAt: new Date(Date.now() + 86400000) } });
    expect(await engine.temporal({ qaMode: true })).toEqual({ inserted: 0 });
    expect(await engine.temporal()).toEqual({ inserted: 1 });
    expect(await prisma.globalCommunicationOutbox.findFirst({ where: { event: 'TRIAL_EXPIRING' } })).toMatchObject({ companyId: commercial });
  });
  it('allowlisted company does not turn commercial facts into QA; commercial ingestion, delivery and recovery stay operational', async () => {
    const payment = await prisma.payment.create({ data: { companyId: qa, planId: plan, gateway: 'STRIPE', environment: 'SANDBOX', amountCents: 9900, status: 'PENDING', creationState: 'CREATED' } });
    const event = await prisma.globalCommunicationOutbox.findFirstOrThrow({ where: { businessKey: `PAYMENT_PENDING:${payment.id}` } });
    expect(await engine.qaPreflight()).toMatchObject({ safeToRun: true, qaEventsPending: [] });
    await engine.runQaWorker(options => inbox.ingest(options));
    expect(await prisma.globalCommunicationOutbox.findUnique({ where: { id: event.id } })).toMatchObject({ notificationProcessedAt: null, expandedAt: null });
    await inbox.ingest(); await engine.run();
    const delivery = await prisma.globalCommunicationDelivery.findFirstOrThrow({ where: { outboxId: event.id } });
    expect(delivery.status).toBe('ACCEPTED'); expect(send).toHaveBeenCalledTimes(1);
    await prisma.globalCommunicationDelivery.update({ where: { id: delivery.id }, data: { status: 'SENDING', startedAt: new Date(0) } });
    await engine.run();
    expect(await prisma.globalCommunicationDelivery.findUnique({ where: { id: delivery.id } })).toMatchObject({ status: 'UNCERTAIN', lastError: 'WORKER_INTERRUPTED' });
  });
  it('PROD blocks QA even with simulation flag enabled; disabled flag cannot claim simulations', async () => {
    await pending();
    vi.stubEnv('COMMERCIAL_QA_SIMULATION_ENABLED', 'false');
    await inbox.ingest({ qaMode: true }); expect((await qaEvent()).notificationProcessedAt).toBeNull();
    expect(await engine.qaPreflight()).toMatchObject({ qaEventsPending: [] });
    vi.stubEnv('COMMERCIAL_QA_SIMULATION_ENABLED', 'true');
    vi.stubEnv('EVOLUTION_WEBHOOK_BASE_URL', 'https://api.kalend.tech'); vi.stubEnv('BILLING_PUBLIC_API_URL', 'https://api.kalend.tech'); vi.stubEnv('DATABASE_URL', 'postgresql://test:unused@localhost/kalend');
    expect(() => communicationEventScope(true)).toThrow('QA_COMMUNICATION_DISABLED');
    await expect(engine.runQaWorker(options => inbox.ingest(options))).rejects.toThrow('QA_COMMUNICATION_DISABLED');
    await inbox.ingest(); await engine.run(); expect(await qaEvent()).toMatchObject({ notificationProcessedAt: null, expandedAt: null });
  });
});
