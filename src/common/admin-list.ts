import { BadRequestException } from '@nestjs/common';
import { object } from './validation.js';
/** Existing array responses remain compatible; clients may request bounded server pages. */
export function adminList(
  input: unknown = {},
  filters: readonly ('q' | 'status')[] = ['q', 'status'],
) {
  const d = object(input, ['limit', 'offset', ...filters]);
  const number = (v: unknown, fallback: number, max: number) => {
    if (v === undefined) return fallback;
    if (typeof v !== 'string' || !/^\d{1,7}$/.test(v) || Number(v) > max)
      throw new BadRequestException('PAGE_INVALID');
    return Number(v);
  };
  const take = number(d.limit, 100, 100),
    skip = number(d.offset, 0, 1000000);
  if (!take) throw new BadRequestException('PAGE_INVALID');
  for (const key of ['q', 'status'])
    if (
      d[key] !== undefined &&
      (typeof d[key] !== 'string' || (d[key] as string).length > 100)
    )
      throw new BadRequestException('FILTER_INVALID');
  return {
    take,
    skip,
    q: d.q as string | undefined,
    status: d.status as string | undefined,
  };
}
export function listStatus<const T extends readonly string[]>(
  status: string | undefined,
  allowed: T,
) {
  if (status !== undefined && !allowed.includes(status))
    throw new BadRequestException('STATUS_INVALID');
  return status as T[number] | undefined;
}
