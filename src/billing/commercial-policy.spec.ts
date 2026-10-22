import { graceDeadline, graceEnd } from './commercial-policy.js';
const end = new Date('2026-10-01T00:00:00.000Z');
afterEach(() => vi.unstubAllEnvs());
describe('grace deadline never creates the original commercial right', () => {
  it.each([0, 1, 999])(
    'requires a persisted period even with %i days configured',
    (days) => {
      expect(graceDeadline(null, end, days)).toBeNull();
    },
  );
  it('zero tolerance has no grace deadline and does not extend a future paid period', () => {
    expect(graceDeadline(end, new Date(end.getTime() - 1), 0)).toBeNull();
  });
  it('uses exactly 24 hours in UTC per day, anchored to the period, not the processing time', () => {
    const now = new Date(end.getTime() + 1000);
    expect(graceDeadline(end, now, 1)?.toISOString()).toBe(
      '2026-10-02T00:00:00.000Z',
    );
    expect(graceDeadline(end, new Date(now.getTime() + 5000), 1)).toEqual(
      graceDeadline(end, now, 1),
    );
  });
  it('the exact end of the grace window is expired', () => {
    expect(
      graceDeadline(end, new Date(end.getTime() + 86400000), 1),
    ).toBeNull();
    expect(
      graceDeadline(end, new Date(end.getTime() + 86400000 - 1), 1),
    ).not.toBeNull();
  });
  it.each(['-1', '1.5', '1000', 'true'])(
    'rejects invalid global tolerance %s',
    (value) => {
      vi.stubEnv('BILLING_GRACE_DAYS', value);
      expect(() => graceEnd(end)).toThrow('BILLING_GRACE_DAYS_INVALID');
    },
  );
});
