import { assertGiftSource } from './gift-card-domain.js';
const sale = (patch: Record<string, unknown> = {}) =>
  ({
    lines: [{ quantity: 1, voidedAt: null }],
    discountCents: 0,
    totalCents: 10000,
    payments: [{ method: 'CASH' }],
    ...patch,
  }) as never;
it('requires exact external financing before issuing gift credit, rejecting discounts, mixed items and prepaid recycling', () => {
  expect(() => assertGiftSource(sale(), 10000)).not.toThrow();
  for (const patch of [
    { discountCents: 1 },
    { totalCents: 9000 },
    { lines: [{ quantity: 2, voidedAt: null }] },
    {
      lines: [
        { quantity: 1, voidedAt: null },
        { quantity: 1, voidedAt: null },
      ],
    },
    { payments: [{ method: 'GIFT_CARD' }] },
  ])
    expect(() => assertGiftSource(sale(patch), 10000)).toThrow('integral');
});
