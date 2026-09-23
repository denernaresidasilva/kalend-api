import { DashboardService } from './dashboard.service.js';
it('dashboard counts actual groups without treating manual activation as revenue', async () => {
  const db = {
    company: {
      groupBy: vi
        .fn()
        .mockResolvedValue([
          { status: 'TRIAL', isActive: true, _count: { _all: 1 } },
        ]),
      count: vi.fn().mockResolvedValue(1),
    },
    user: { count: vi.fn().mockResolvedValue(1) },
    subscription: {
      groupBy: vi
        .fn()
        .mockResolvedValue([{ status: 'TRIALING', _count: { _all: 1 } }]),
    },
    payment: {
      groupBy: vi.fn().mockResolvedValue([]),
      aggregate: vi.fn().mockResolvedValue({ _sum: { amountCents: null } }),
    },
    webhookEvent: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation((fn) => fn(db));
  const result = await new DashboardService(db as never).summary();
  expect(result.companies).toEqual({
    total: 1,
    active: 0,
    trial: 1,
    suspended: 0,
    canceled: 0,
    inactive: 0,
    new: 1,
  });
  expect(result.users.total).toBe(1);
  expect(result.subscriptions.trialing).toBe(1);
  expect(result.payments.revenueCents).toBe(0);
  expect(db.$transaction.mock.calls[0][1]).toEqual({
    isolationLevel: 'RepeatableRead',
  });
});
