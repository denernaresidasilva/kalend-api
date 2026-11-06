import { addCycleMonths } from './client-subscription-domain.js';
it('renews real calendar months without charging fictitious 30-day periods or overflowing month-end', () => {
  expect(
    addCycleMonths(new Date('2027-01-31T12:00:00Z'), 1).toISOString(),
  ).toBe('2027-02-28T12:00:00.000Z');
  expect(
    addCycleMonths(new Date('2028-01-31T12:00:00Z'), 1).toISOString(),
  ).toBe('2028-02-29T12:00:00.000Z');
  expect(
    addCycleMonths(new Date('2026-11-06T12:00:00Z'), 1).toISOString(),
  ).toBe('2026-12-06T12:00:00.000Z');
});
it('preserves establishment wall time across daylight saving changes', () => {
  expect(
    addCycleMonths(
      new Date('2026-02-28T15:00:00Z'),
      1,
      'America/New_York',
    ).toISOString(),
  ).toBe('2026-03-28T14:00:00.000Z');
});
