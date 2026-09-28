import { PaymentsService } from './payments.service.js';
import { WebhookProcessor } from './webhook-processor.service.js';
import { GatewayRegistry } from './gateway.provider.js';
const companyId = '11111111-1111-4111-8111-111111111111';
const planId = '33333333-3333-4333-8333-333333333333';
const input = {
  planId,
  gateway: 'STRIPE',
  billingInterval: 'MONTHLY',
  idempotencyKey: 'request-1',
};
function setup() {
  let payment: any = null;
  const sub: any = {
    id: '22222222-2222-4222-8222-222222222222',
    companyId,
    planId,
    status: 'PENDING',
    createdAt: new Date(),
    currentPeriodEnd: null,
  };
  const provider = {
    createCharge: vi.fn().mockResolvedValue({
      externalPaymentId: 'pi_1',
      checkoutUrl: 'https://checkout.stripe.com/pay',
    }),
  };
  const db = {
    gatewayConfiguration: {
      findUnique: vi
        .fn()
        .mockResolvedValue({
          enabled: true,
          environment: 'SANDBOX',
          updatedAt: new Date(1),
        }),
    },
    plan: {
      findFirst: vi.fn().mockResolvedValue({
        id: planId,
        isActive: true,
        monthlyPriceCents: 9900,
      }),
    },
    membership: {
      findFirst: vi.fn().mockResolvedValue({
        user: { name: 'Test', email: 'test@example.test' },
      }),
    },
    subscription: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi
        .fn()
        .mockImplementation(({ data }) => Object.assign(sub, data)),
      update: vi
        .fn()
        .mockImplementation(({ data }) => Object.assign(sub, data)),
      updateMany: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
    payment: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockImplementation(() => payment),
      create: vi.fn().mockImplementation(
        ({ data }) =>
          (payment = {
            id: '44444444-4444-4444-8444-444444444444',
            creationState: 'READY',
            refundedAmountCents: 0,
            ...data,
            subscription: sub,
          }),
      ),
      updateMany: vi.fn().mockImplementation(({ where, data }) => {
        if (where.creationState !== payment.creationState) return { count: 0 };
        Object.assign(payment, data);
        return { count: 1 };
      }),
      update: vi
        .fn()
        .mockImplementation(({ data }) => Object.assign(payment, data)),
    },
    webhookEvent: {
      upsert: vi.fn().mockResolvedValue({ id: 'event', status: 'RECEIVED' }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn(),
    },
    company: { update: vi.fn() },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation((fn) => fn(db));
  const service = new PaymentsService(
    db as never,
    { get: () => provider } as never,
    {
      context: async () => ({
        environment: 'SANDBOX',
        configurationVersion: new Date(1),
      }),
    } as never,
  );
  return { db, sub, service, provider, payment: () => payment };
}
describe('internal checkout', () => {
  it('refuses intent creation when gateway configuration changes concurrently', async () => {
    const { service, provider, db } = setup();
    db.gatewayConfiguration.findUnique.mockResolvedValue({
      enabled: true,
      environment: 'PRODUCTION',
      updatedAt: new Date(2),
    });
    await expect(service.checkout(companyId, input)).rejects.toThrow(
      'GATEWAY_CONFIGURATION_CHANGED',
    );
    expect(db.payment.create).not.toHaveBeenCalled();
    expect(provider.createCharge).not.toHaveBeenCalled();
  });
  it('uses DB price; persists intent BEFORE network and idempotently returns the same checkout', async () => {
    const { service, provider, db } = setup();
    provider.createCharge.mockImplementation(async () => {
      expect(db.payment.create).toHaveBeenCalledOnce();
      return {
        externalPaymentId: 'pi_1',
        checkoutUrl: 'https://checkout.stripe.com/pay',
      };
    });
    await service.checkout(companyId, input);
    await service.checkout(companyId, input);
    expect(provider.createCharge).toHaveBeenCalledOnce();
    expect(provider.createCharge.mock.calls[0][0]).toMatchObject({
      amountCents: 9900,
      planId,
      companyId,
    });
  });
  it.each([
    'amountCents',
    'currency',
    'companyId',
    'status',
    'environment',
    'expectedAmount',
  ])('rejects injected %s', async (field) => {
    const { service, provider } = setup();
    await expect(
      service.checkout(companyId, { ...input, [field]: 1 }),
    ).rejects.toThrow();
    expect(provider.createCharge).not.toHaveBeenCalled();
  });
  it('expired Premium trial followed by Pro purchase activates Pro only', async () => {
    const { service, provider, db, sub } = setup();
    const premium = { id: 'old-trial', planId: 'premium', status: 'EXPIRED' };
    await service.checkout(companyId, input);
    expect(sub.planId).toBe(planId);
    expect(sub.planId).not.toBe(premium.planId);
    const processor = new WebhookProcessor(
      db as never,
      new GatewayRegistry(),
      {} as never,
    );
    await processor.processVerified('STRIPE', {
      environment: 'SANDBOX',
      eventId: 'evt_1',
      type: 'payment',
      externalPaymentId: 'pi_1',
      status: 'APPROVED',
      amountCents: 9900,
      currency: 'BRL',
    });
    expect(sub.status).toBe('ACTIVE');
    expect(sub.planId).toBe(planId);
    expect(premium.status).toBe('EXPIRED');
    expect(provider.createCharge).toHaveBeenCalledOnce();
  });
  it('does not repeat an uncertain external operation', async () => {
    const { service, provider, payment } = setup();
    provider.createCharge.mockRejectedValue(
      new Error('private-provider-response'),
    );
    await expect(service.checkout(companyId, input)).rejects.toThrow(
      'CHECKOUT_RECONCILIATION_REQUIRED',
    );
    expect(payment().creationState).toBe('UNCERTAIN');
    await expect(service.checkout(companyId, input)).rejects.toThrow(
      'CHECKOUT_RECONCILIATION_REQUIRED',
    );
    expect(provider.createCharge).toHaveBeenCalledOnce();
  });
  it('rejects reused key with another plan or environment', async () => {
    const { service, payment } = setup();
    await service.checkout(companyId, input);
    payment().environment = 'PRODUCTION';
    await expect(service.checkout(companyId, input)).rejects.toThrow(
      'IDEMPOTENCY_SCOPE_MISMATCH',
    );
  });
  it('does not allow a second simultaneous checkout', async () => {
    const { service, db, provider } = setup();
    db.payment.findFirst.mockResolvedValue({ id: 'pending' } as never);
    await expect(service.checkout(companyId, input)).rejects.toThrow(
      'CHECKOUT_ALREADY_PENDING',
    );
    expect(provider.createCharge).not.toHaveBeenCalled();
  });
});
