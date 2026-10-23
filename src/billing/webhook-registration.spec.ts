import { Prisma } from '@prisma/client';
import { WebhookProcessor } from './webhook-processor.service.js';

const conflict = () =>
  new Prisma.PrismaClientKnownRequestError('synthetic registration race', {
    code: 'P2002',
    clientVersion: 'test',
  });
const event = {
  eventId: 'same-provider-event',
  type: 'APPROVED',
  status: 'APPROVED' as const,
  externalPaymentId: 'synthetic-payment',
  environment: 'SANDBOX' as const,
  amountCents: 199,
  currency: 'BRL',
};

it('recovers a registration unique conflict by re-reading the existing event', async () => {
  const upsert = vi
    .fn()
    .mockRejectedValueOnce(conflict())
    .mockResolvedValue({ id: 'event', status: 'PROCESSED' });
  const transaction = vi.fn();
  const processor = new WebhookProcessor(
    { webhookEvent: { upsert }, $transaction: transaction } as never,
    {} as never,
    {} as never,
  );
  await expect(processor.processVerified('STRIPE', event)).resolves.toEqual({
    id: 'event',
    status: 'PROCESSED',
    duplicate: true,
  });
  expect(upsert).toHaveBeenCalledTimes(2);
  expect(upsert.mock.calls[0]).toEqual(upsert.mock.calls[1]);
  expect(transaction).not.toHaveBeenCalled();
});

it('stops after three failed registration attempts without processing a payment', async () => {
  const failure = conflict();
  const upsert = vi.fn().mockRejectedValue(failure);
  const transaction = vi.fn();
  const processor = new WebhookProcessor(
    { webhookEvent: { upsert }, $transaction: transaction } as never,
    {} as never,
    {} as never,
  );
  await expect(processor.processVerified('STRIPE', event)).rejects.toBe(
    failure,
  );
  expect(upsert).toHaveBeenCalledTimes(3);
  expect(transaction).not.toHaveBeenCalled();
});

it('does not retry unrelated registration errors', async () => {
  const failure = new Error('synthetic unavailable');
  const upsert = vi.fn().mockRejectedValue(failure);
  const processor = new WebhookProcessor(
    { webhookEvent: { upsert } } as never,
    {} as never,
    {} as never,
  );
  await expect(processor.processVerified('STRIPE', event)).rejects.toBe(
    failure,
  );
  expect(upsert).toHaveBeenCalledTimes(1);
});
