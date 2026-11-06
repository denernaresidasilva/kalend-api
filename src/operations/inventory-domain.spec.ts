import { materialQuantity } from './inventory-domain.js';
it('uses integer milli-units for fractional service materials without float drift', () => {
  expect(materialQuantity(125, 3)).toBe(375);
  expect(materialQuantity(1000, 100)).toBe(100000);
  expect(() => materialQuantity(0, 1)).toThrow();
  expect(() => materialQuantity(100000000, 100)).toThrow();
});
