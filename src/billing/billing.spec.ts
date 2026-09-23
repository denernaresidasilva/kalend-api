import { PaymentsService } from './payments.service.js';
import { WebhookProcessor } from './webhook-processor.service.js';
import { SecretVault } from './secret-vault.js';
import { GatewayRegistry } from './gateway.provider.js';
import { GatewaysService } from './gateways.service.js';
import { nextPeriod } from '../common/period.js';
const companyId = '11111111-1111-4111-8111-111111111111';
const subscriptionId = '22222222-2222-4222-8222-222222222222';
const planId = '33333333-3333-4333-8333-333333333333';
const request = {
  companyId,
  subscriptionId,
  planId,
  gateway: 'STRIPE',
  idempotencyKey: 'request-1',
};
describe('payments', () => {
  function setup() {
    const provider = {
      createCharge: vi.fn().mockResolvedValue({ externalPaymentId: 'ext-1' }),
    };
    const db = {
      subscription: {
        findFirst: vi.fn().mockResolvedValue({
          billingInterval: 'MONTHLY',
          status: 'TRIALING',
          plan: { isActive: true, monthlyPriceCents: 9900 },
        }),
      },
      payment: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi
          .fn()
          .mockImplementation(({ data }) => ({ ...data, id: 'payment' })),
        update: vi.fn(),
      },
    };
    const service = new PaymentsService(
      db as never,
      { get: () => provider } as never,
      { context: async () => ({ environment: 'SANDBOX' }) } as never,
    );
    return { db, provider, service };
  }
  it('uses Plan price and backend period', async () => {
    const { service, provider } = setup();
    await service.create(request);
    expect(provider.createCharge.mock.calls[0][0].amountCents).toBe(9900);
  });
  it('rejects price injection', async () => {
    const { service } = setup();
    await expect(
      service.create({ ...request, amountCents: 1 }),
    ).rejects.toThrow();
  });
  it('isolates subscription lookup by company AND plan', async () => {
    const { service, db, provider } = setup();
    db.subscription.findFirst.mockResolvedValue(null as never);
    await expect(service.create(request)).rejects.toThrow();
    expect(db.subscription.findFirst.mock.calls[0][0].where).toEqual({
      id: subscriptionId,
      companyId,
      planId,
    });
    expect(provider.createCharge).not.toHaveBeenCalled();
  });
  it('rejects cross-company idempotency reuse', async () => {
    const { service, db, provider } = setup();
    db.payment.findUnique.mockResolvedValue({ companyId: 'other' } as never);
    await expect(service.create(request)).rejects.toThrow();
    expect(provider.createCharge).not.toHaveBeenCalled();
  });
});
describe('verified webhook transaction', () => {
  function setup() {
    const eventRow = {
      environment: 'SANDBOX',
      id: 'event',
      status: 'RECEIVED',
      paymentId: 'payment',
    };
    const payment = {
      id: 'payment',
      environment: 'SANDBOX',
      companyId,
      subscriptionId,
      planId,
      amountCents: 9900,
      currency: 'BRL',
      status: 'PENDING',
      periodStart: new Date('2026-01-01'),
      periodEnd: new Date('2026-02-01'),
      subscription: {
        id: subscriptionId,
        companyId,
        planId,
        status: 'TRIALING',
        currentPeriodEnd: null,
      },
    };
    const db = {
      payment: {
        findUnique: vi.fn().mockImplementation(async () => payment),
        update: vi
          .fn()
          .mockImplementation(async ({ data }) => Object.assign(payment, data)),
      },
      webhookEvent: {
        upsert: vi.fn().mockImplementation(async () => eventRow),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi
          .fn()
          .mockImplementation(async ({ data }) =>
            Object.assign(eventRow, data),
          ),
      },
      subscription: { update: vi.fn(), count: vi.fn().mockResolvedValue(0) },
      company: { update: vi.fn() },
      $transaction: vi.fn(),
    };
    db.$transaction.mockImplementation((fn) => fn(db));
    const service = new WebhookProcessor(
      db as never,
      new GatewayRegistry(),
      {} as never,
    );
    const event = {
      environment: 'SANDBOX' as const,
      eventId: 'evt-1',
      type: 'payment',
      externalPaymentId: 'ext-1',
      status: 'APPROVED' as const,
      amountCents: 9900,
      currency: 'BRL',
    };
    return { db, service, event, payment, eventRow };
  }
  it('approval atomically activates correct subscription/company', async () => {
    const { db, service, event } = setup();
    await service.processVerified('STRIPE', event);
    expect(db.payment.update.mock.calls[0][0].data.status).toBe('APPROVED');
    expect(db.subscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: subscriptionId },
        data: expect.objectContaining({ status: 'ACTIVE' }),
      }),
    );
    expect(db.company.update).toHaveBeenCalledWith({
      where: { id: companyId },
      data: { status: 'ACTIVE', isActive: true },
    });
    expect(db.$transaction.mock.calls[0][1]).toEqual({
      isolationLevel: 'Serializable',
    });
  });
  it('duplicate does not activate or renew twice', async () => {
    const { db, service, event } = setup();
    await service.processVerified('STRIPE', event);
    await service.processVerified('STRIPE', event);
    expect(db.payment.update).toHaveBeenCalledOnce();
    expect(db.subscription.update).toHaveBeenCalledOnce();
  });
  it('another event ID for same payment does not extend paid period', async () => {
    const { db, service, event, eventRow } = setup();
    await service.processVerified('STRIPE', event);
    eventRow.status = 'RECEIVED';
    await service.processVerified('STRIPE', { ...event, eventId: 'evt-2' });
    expect(db.subscription.update).toHaveBeenCalledOnce();
  });
  it('failure does not activate', async () => {
    const { db, service, event } = setup();
    await service.processVerified('STRIPE', { ...event, status: 'FAILED' });
    expect(db.payment.update.mock.calls[0][0].data.status).toBe('FAILED');
    expect(db.company.update).not.toHaveBeenCalled();
  });
  it('rejects amount mismatch and stores only sanitized error', async () => {
    const { db, service, event } = setup();
    await expect(
      service.processVerified('STRIPE', { ...event, amountCents: 1 }),
    ).rejects.toThrow('WEBHOOK_PROCESSING_FAILED');
    expect(db.payment.update).not.toHaveBeenCalled();
    expect(db.webhookEvent.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ errorMessage: 'PROCESSING_FAILED' }),
      }),
    );
  });
  it('rejects sandbox event for production payment', async () => {
    const { db, service, event, payment } = setup();
    payment.environment = 'PRODUCTION';
    await expect(service.processVerified('STRIPE', event)).rejects.toThrow();
    expect(db.company.update).not.toHaveBeenCalled();
  });
  it('rejects cross-company subscription', async () => {
    const { db, service, event, payment } = setup();
    payment.subscription.companyId = 'other';
    await expect(service.processVerified('STRIPE', event)).rejects.toThrow();
    expect(db.company.update).not.toHaveBeenCalled();
  });
  it('public receiver fails closed without provider and writes nothing', async () => {
    const { db, service } = setup();
    await expect(
      service.receive('STRIPE', Buffer.from('{}'), {}),
    ).rejects.toThrow('GATEWAY_ADAPTER_PENDING');
    expect(db.webhookEvent.upsert).not.toHaveBeenCalled();
  });
});
describe('secrets and periods', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('encrypts with authenticated scope; tampering fails', () => {
    vi.stubEnv('GATEWAY_ENCRYPTION_KEY', 'ab'.repeat(32));
    const vault = new SecretVault();
    const encrypted = vault.encrypt(
      'private-test-value',
      'STRIPE:SANDBOX:credentials',
    );
    expect(encrypted).not.toContain('private-test-value');
    expect(vault.decrypt(encrypted, 'STRIPE:SANDBOX:credentials')).toBe(
      'private-test-value',
    );
    expect(() =>
      vault.decrypt(encrypted, 'PAGBANK:SANDBOX:credentials'),
    ).toThrow();
  });
  it('configuration returns flags only', async () => {
    const db = {
      gatewayConfiguration: {
        findUnique: vi.fn().mockResolvedValue({
          credentialsEncrypted: 'ciphertext',
          webhookSecretEncrypted: 'private',
          environment: 'SANDBOX',
        }),
      },
    };
    const service = new GatewaysService(
      db as never,
      new SecretVault(),
      new GatewayRegistry(),
    );
    const result = await service.get('STRIPE');
    expect(result.configured).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(
      /ciphertext|private|credentialsEncrypted|webhookSecretEncrypted/,
    );
  });
  it('does not report a fake connection', async () => {
    const service = new GatewaysService(
      {} as never,
      new SecretVault(),
      new GatewayRegistry(),
    );
    await expect(service.test('STRIPE')).rejects.toThrow(
      'GATEWAY_ADAPTER_PENDING',
    );
  });
  it('clamps monthly/yearly period at month end', () => {
    expect(
      nextPeriod(new Date('2026-01-31T10:00:00Z'), 'MONTHLY').toISOString(),
    ).toBe('2026-02-28T10:00:00.000Z');
    expect(
      nextPeriod(new Date('2024-02-29T10:00:00Z'), 'YEARLY').toISOString(),
    ).toBe('2025-02-28T10:00:00.000Z');
  });
});
