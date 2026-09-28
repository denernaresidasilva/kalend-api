import { WebhookProcessor } from './webhook-processor.service.js';
import { SecretVault } from './secret-vault.js';
import { GatewayRegistry } from './gateway.provider.js';
import { GatewaysService } from './gateways.service.js';
import { nextPeriod } from '../common/period.js';
const companyId = '11111111-1111-4111-8111-111111111111';
const subscriptionId = '22222222-2222-4222-8222-222222222222';
const planId = '33333333-3333-4333-8333-333333333333';
describe.each(['STRIPE', 'PAGBANK'] as const)(
  '%s verified webhook transaction',
  (gateway) => {
    function setup() {
      const eventRow = {
        environment: 'SANDBOX',
        id: 'event',
        status: 'RECEIVED',
        paymentId: 'payment',
      };
      const payment = {
        id: 'payment',
        gateway,
        refundedAmountCents: 0,
        environment: 'SANDBOX',
        companyId,
        subscriptionId,
        planId,
        amountCents: 9900,
        currency: 'BRL',
        status: 'PENDING',
        periodStart: new Date(),
        periodEnd: new Date(Date.now() + 30 * 86400000),
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
            .mockImplementation(async ({ data }) =>
              Object.assign(payment, data),
            ),
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
        subscription: {
          update: vi.fn(),
          updateMany: vi.fn(),
          findFirst: vi.fn().mockResolvedValue(null),
          count: vi.fn().mockResolvedValue(0),
        },
        company: { update: vi.fn() },
        $transaction: vi.fn(),
      };
      db.$transaction.mockImplementation((fn) => fn(db));
      const service = new WebhookProcessor(db as never, new GatewayRegistry(), {
        context: vi.fn().mockRejectedValue(new Error('GATEWAY_NOT_ENABLED')),
      } as never);
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
      await service.processVerified(gateway, event);
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
      await service.processVerified(gateway, event);
      await service.processVerified(gateway, event);
      expect(db.payment.update).toHaveBeenCalledOnce();
      expect(db.subscription.update).toHaveBeenCalledOnce();
    });
    it('another event ID for same payment does not extend paid period', async () => {
      const { db, service, event, eventRow } = setup();
      await service.processVerified(gateway, event);
      eventRow.status = 'RECEIVED';
      await service.processVerified(gateway, { ...event, eventId: 'evt-2' });
      expect(db.subscription.update).toHaveBeenCalledOnce();
    });
    it('failure does not activate', async () => {
      const { db, service, event } = setup();
      await service.processVerified(gateway, { ...event, status: 'FAILED' });
      expect(db.payment.update.mock.calls[0][0].data.status).toBe('FAILED');
      expect(db.company.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'ACTIVE' }),
        }),
      );
    });
    it('rejects amount mismatch and stores only sanitized error', async () => {
      const { db, service, event } = setup();
      await expect(
        service.processVerified(gateway, { ...event, amountCents: 1 }),
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
      await expect(service.processVerified(gateway, event)).rejects.toThrow();
      expect(db.company.update).not.toHaveBeenCalled();
    });
    it('rejects cross-company subscription', async () => {
      const { db, service, event, payment } = setup();
      payment.subscription.companyId = 'other';
      await expect(service.processVerified(gateway, event)).rejects.toThrow();
      expect(db.company.update).not.toHaveBeenCalled();
    });
    it('rejects incorrect currency before any event mutation', async () => {
      const { db, service, event } = setup();
      await expect(
        service.processVerified(gateway, { ...event, currency: 'USD' }),
      ).rejects.toThrow();
      expect(db.webhookEvent.upsert).not.toHaveBeenCalled();
    });
    it('overdue marks past due, then a valid late approval reactivates', async () => {
      const { db, service, event, eventRow, payment } = setup();
      await service.processVerified(gateway, { ...event, status: 'OVERDUE' });
      expect(db.subscription.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'PAST_DUE' }),
        }),
      );
      eventRow.status = 'RECEIVED';
      payment.subscription.status = 'PAST_DUE';
      await service.processVerified(gateway, {
        ...event,
        eventId: 'late-payment',
      });
      expect(db.company.update).toHaveBeenLastCalledWith({
        where: { id: companyId },
        data: { status: 'ACTIVE', isActive: true },
      });
    });
    it('full refund revokes only the covered current period and is idempotent', async () => {
      const { db, service, event, eventRow, payment } = setup();
      payment.status = 'APPROVED';
      payment.subscription.currentPeriodEnd = payment.periodEnd as never;
      await service.processVerified(gateway, { ...event, status: 'REFUNDED' });
      expect(db.subscription.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'SUSPENDED' }),
        }),
      );
      eventRow.status = 'RECEIVED';
      await service.processVerified(gateway, {
        ...event,
        eventId: 'refund-repeat',
        status: 'REFUNDED',
      });
      expect(db.payment.update).toHaveBeenCalledOnce();
    });
    it('partial refund preserves entitlement and records refunded cents', async () => {
      const { db, service, event, payment } = setup();
      payment.status = 'APPROVED';
      await service.processVerified(gateway, {
        ...event,
        status: 'REFUNDED',
        refundedAmountCents: 100,
      });
      expect(db.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'APPROVED',
            refundedAmountCents: 100,
          }),
        }),
      );
      expect(db.subscription.update).not.toHaveBeenCalled();
    });
    it('late payment never reverses cancellation', async () => {
      const { db, service, event, payment } = setup();
      payment.subscription.status = 'CANCELED';
      await service.processVerified(gateway, event);
      expect(db.payment.update).toHaveBeenCalled();
      expect(db.company.update).not.toHaveBeenCalled();
    });
    it('rejects incorrect internal reference even when external ID locates payment', async () => {
      const { service, event, db } = setup();
      await expect(
        service.processVerified(gateway, {
          ...event,
          externalReference: 'wrong',
        }),
      ).rejects.toThrow('WEBHOOK_PROCESSING_FAILED');
      expect(db.payment.update).not.toHaveBeenCalled();
    });
    it('webhook and reconcile competing events activate once under serialized transactions', async () => {
      const { service, event, db } = setup();
      const rows = new Map<string, Record<string, unknown>>();
      db.webhookEvent.upsert.mockImplementation(async ({ create }) => {
        const row = {
          ...create,
          id: create.externalEventId,
          status: 'RECEIVED',
        };
        rows.set(row.id, row);
        return row;
      });
      db.webhookEvent.update.mockImplementation(
        async ({ where, data }) =>
          Object.assign(rows.get(where.id)!, data) as never,
      );
      let queue = Promise.resolve();
      db.$transaction.mockImplementation((fn) => {
        const task = queue.then(() => fn(db));
        queue = task.then(() => undefined);
        return task;
      });
      await Promise.all([
        service.processVerified(gateway, { ...event, eventId: 'webhook' }),
        service.processVerified(gateway, {
          ...event,
          eventId: 'reconcile:ext-1:PAID:0',
        }),
      ]);
      expect(db.payment.update).toHaveBeenCalledOnce();
      expect(db.subscription.update).toHaveBeenCalledOnce();
      expect(
        db.$transaction.mock.calls.every(
          (call) => call[1].isolationLevel === 'Serializable',
        ),
      ).toBe(true);
    });
    it('public receiver fails closed without provider and writes nothing', async () => {
      const { db, service } = setup();
      await expect(
        service.receive(gateway, Buffer.from('{}'), {}),
      ).rejects.toThrow('GATEWAY_NOT_ENABLED');
      expect(db.webhookEvent.upsert).not.toHaveBeenCalled();
    });
  },
);
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
      {
        gatewayConfiguration: { findUnique: vi.fn().mockResolvedValue(null) },
      } as never,
      new SecretVault(),
      new GatewayRegistry(),
    );
    await expect(service.test('STRIPE')).rejects.toThrow('GATEWAY_NOT_ENABLED');
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
