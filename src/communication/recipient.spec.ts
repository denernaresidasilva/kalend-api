import { describe, expect, it } from 'vitest';
import { normalizeBrazilianPhone } from './recipient.js';

describe('commercial Brazilian phone normalization', () => {
  it.each([
    ['12996015129', '+5512996015129'],
    ['5512996015129', '+5512996015129'],
    ['+5512996015129', '+5512996015129'],
    ['(12) 99601-5129', '+5512996015129'],
    ['12 99601-5129', '+5512996015129'],
    ['+55 (12) 99601-5129', '+5512996015129'],
  ])('normalizes %s to %s', (raw, normalized) => {
    expect(normalizeBrazilianPhone(raw)).toBe(normalized);
  });

  it.each(['', 'invalid', '+55+55 12 99601-5129', '123', '123456789012345678901'])
    ('rejects empty, malformed, or duplicated country-code values (%s)', (raw) => {
      expect(normalizeBrazilianPhone(raw)).toBeUndefined();
    });
});
