import { weightedCents } from './package-funding.js';
it('allocates every paid cent across package sessions including discounts, uneven weights and zero-price services', () => {
  for (const amount of [1, 7, 19999, 1000000000])
    for (const weights of [
      [1, 1, 1],
      [15000, 0, 7000],
      [0, 0, 0],
    ]) {
      const values = weightedCents(amount, weights);
      expect(values.reduce((n, v) => n + v, 0)).toBe(amount);
      expect(values.every((v) => Number.isSafeInteger(v) && v >= 0)).toBe(true);
    }
  expect(weightedCents(60000, [15000, 15000, 15000, 15000, 15000])).toEqual([
    12000, 12000, 12000, 12000, 12000,
  ]);
});
