import { LifecycleService } from './lifecycle.service.js';
afterEach(() => vi.unstubAllEnvs());
it('expires trial and suspends only companies without entitlement, without touching users', async () => {
  const db = {
    payment: { findMany: vi.fn().mockResolvedValue([]) },
    subscription: {
      findMany: vi.fn().mockResolvedValue([
        { id: 's1', companyId: 'c1', status: 'TRIALING' },
        {
          id: 's2',
          companyId: 'c2',
          status: 'ACTIVE',
          currentPeriodEnd: new Date(0),
        },
      ]),
      update: vi.fn(),
      count: vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(1),
    },
    company: { update: vi.fn() },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation((fn) => fn(db));
  const result = await new LifecycleService(
    db as never,
    {} as never,
    {} as never,
    {} as never,
  ).reconcile();
  expect(result.expired).toBe(2);
  expect(db.company.update).toHaveBeenCalledOnce();
  expect(db.subscription.update.mock.calls[0][0].data.status).toBe('EXPIRED');
});
it('uses configured grace and queries actual adapter before expiration', async () => {
  vi.stubEnv('BILLING_GRACE_DAYS', '3');
  const db = {
    payment: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          {
            id: 'p',
            gateway: 'STRIPE',
            environment: 'SANDBOX',
            externalPaymentId: 'pi_x',
          },
        ]),
      update: vi.fn(),
    },
    subscription: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          {
            id: 's',
            companyId: 'c',
            status: 'ACTIVE',
            currentPeriodEnd: new Date(Date.now() - 1000),
          },
        ]),
      update: vi.fn(),
      count: vi.fn().mockResolvedValue(1),
    },
    company: { update: vi.fn() },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation((fn) => fn(db));
  const reconcile = vi.fn().mockResolvedValue([{ status: 'APPROVED' }]),
    processVerified = vi.fn();
  const service = new LifecycleService(
    db as never,
    { get: () => ({ reconcile }) } as never,
    { context: async () => ({ environment: 'SANDBOX' }) } as never,
    { processVerified } as never,
  );
  const result = await service.reconcile();
  expect(reconcile).toHaveBeenCalledOnce();
  expect(processVerified).toHaveBeenCalledOnce();
  expect(result.paymentsChecked).toBe(1);
  expect(db.subscription.update.mock.calls[0][0].data.status).toBe('PAST_DUE');
  expect(db.company.update).not.toHaveBeenCalled();
});
