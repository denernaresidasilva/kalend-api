import { BadRequestException } from '@nestjs/common';
import { boolean, integer, object, string } from '../common/validation.js';
export function validatePlan(input: unknown, partial = false) {
  const data = object(input, [
    'name',
    'code',
    'description',
    'monthlyPriceCents',
    'yearlyPriceCents',
    'trialEnabled',
    'trialDays',
    'badge',
    'isFeatured',
    'displayOrder',
    'maxProfessionals',
    'maxClients',
    'maxUnits',
    'isActive',
    'features',
  ]);
  for (const key of ['name', 'code'])
    if (!partial || data[key] !== undefined) string(data[key], key);
  for (const key of ['description', 'badge'])
    if (data[key] !== undefined) string(data[key], key, 2000);
  for (const key of [
    'monthlyPriceCents',
    'yearlyPriceCents',
    'trialDays',
    'displayOrder',
    'maxProfessionals',
    'maxClients',
    'maxUnits',
  ]) {
    if (data[key] !== undefined || (!partial && key === 'monthlyPriceCents'))
      integer(
        data[key],
        key,
        key === 'trialDays' ? 1 : 0,
        key === 'trialDays' ? 365 : 2147483647,
      );
  }
  for (const key of ['trialEnabled', 'isFeatured', 'isActive'])
    boolean(data[key], key);
  if (data.features !== undefined) {
    if (!Array.isArray(data.features) || data.features.length > 100)
      throw new BadRequestException('Features inválidas.');
    const codes = new Set<string>();
    for (const feature of data.features) {
      const f = object(feature, ['code', 'name', 'enabled']);
      const code = string(f.code, 'code').toLowerCase();
      string(f.name, 'name');
      boolean(f.enabled, 'enabled');
      if (codes.has(code)) throw new BadRequestException('Feature duplicada.');
      codes.add(code);
    }
  }
}
