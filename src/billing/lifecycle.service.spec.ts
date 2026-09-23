import { LifecycleService } from './lifecycle.service.js';
it('expires elapsed periods and suspends only companies without another valid subscription', async () => {
  const db = {
    subscription: {
      findMany: vi.fn().mockResolvedValue([
        { id: 's1', companyId: 'c1' },
        { id: 's2', companyId: 'c2' },
      ]),
      updateMany: vi.fn().mockResolvedValue({ count: 2 }),
      count: vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(1),
    },
    company: { updateMany: vi.fn() },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation((fn) => fn(db));
  const result = await new LifecycleService(db as never).reconcile();
  expect(result.expired).toBe(2);
  expect(db.company.updateMany).toHaveBeenCalledOnce();
  expect(db.company.updateMany.mock.calls[0][0].where.id).toBe('c1');
  expect(db.subscription.findMany.mock.calls[0][0].where.OR).toEqual([
    { status: 'TRIALING', trialEndsAt: { lte: expect.any(Date) } },
    { status: 'ACTIVE', currentPeriodEnd: { lte: expect.any(Date) } },
  ]);
});
