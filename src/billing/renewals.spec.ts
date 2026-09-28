import { WebhookProcessor } from './webhook-processor.service.js';
import type { VerifiedEvent } from './gateway.types.js';
it('new recurring invoice uses subscription price snapshot, not current Plan or the original trial', async () => {
  const sub = {
    id: 'sub-pro',
    companyId: 'company',
    planId: 'pro',
    gateway: 'STRIPE',
    environment: 'SANDBOX',
    billingInterval: 'MONTHLY',
    expectedAmountCents: 9900,
    currency: 'BRL',
    status: 'ACTIVE',
    externalSubscriptionId: 'sub_external',
    currentPeriodEnd: new Date('2026-09-20'),
    createdAt: new Date('2026-01-01'),
  };
  const db = {
    payment: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi
        .fn()
        .mockImplementation(({ data }) => ({
          ...data,
          id: 'renewal',
          subscription: sub,
          refundedAmountCents: 0,
        })),
      update: vi.fn(),
    },
    subscription: {
      findUnique: vi.fn().mockResolvedValue(sub),
      findFirst: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn(),
      update: vi.fn(),
    },
    company: { update: vi.fn() },
    webhookEvent: {
      upsert: vi.fn().mockResolvedValue({ id: 'evt', status: 'RECEIVED' }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn(),
    },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation((fn) => fn(db));
  const service = new WebhookProcessor(db as never, {} as never, {} as never);
  const start = new Date(),
    end = new Date(Date.now() + 30 * 86400000);
  const event: VerifiedEvent = {
    eventId: 'invoice-2',
    type: 'invoice.paid',
    externalPaymentId: 'in_2',
    externalReference: 'first-payment',
    externalSubscriptionId: 'sub_external',
    environment: 'SANDBOX',
    amountCents: 9900,
    currency: 'BRL',
    status: 'APPROVED',
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
  };
  await service.processVerified('STRIPE', event);
  expect(db.payment.create).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        planId: 'pro',
        amountCents: 9900,
        externalPaymentId: 'in_2',
        periodStart: start,
      }),
    }),
  );
  expect(db.subscription.update).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { id: 'sub-pro' },
      data: expect.objectContaining({
        status: 'ACTIVE',
        currentPeriodEnd: end,
      }),
    }),
  );
});
