import { Prisma } from '@prisma/client';
import { retryableBillingConflict } from './transaction-conflict.js';
const failure = (code: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError('synthetic', {
    code,
    clientVersion: 'test',
    meta,
  });
it.each(['P2002', 'P2034'])('keeps bounded retry support for %s', (code) => {
  expect(retryableBillingConflict(failure(code))).toBe(true);
});
it.each(['40001', '40P01'])(
  'recognizes native raw-query SQLSTATE %s',
  (state) => {
    expect(
      retryableBillingConflict(
        failure('P2010', {
          driverAdapterError: { cause: { originalCode: state } },
        }),
      ),
    ).toBe(true);
    expect(retryableBillingConflict(failure('P2010', { code: state }))).toBe(
      true,
    );
  },
);
it.each(['23503', '42501', '42601', '08006'])(
  'does not retry unrelated SQLSTATE %s',
  (state) => {
    expect(
      retryableBillingConflict(
        failure('P2010', {
          driverAdapterError: { cause: { originalCode: state } },
        }),
      ),
    ).toBe(false);
  },
);
it('rejects unknown errors and spoofed adapter conflict labels', () => {
  expect(retryableBillingConflict(new Error('40001'))).toBe(false);
  expect(retryableBillingConflict({ code: 'P2034' })).toBe(false);
  expect(retryableBillingConflict(failure('P2010'))).toBe(false);
});
it('retries the entire operation at most three times', async () => {
  const { withBillingConflictRetry } =
    await import('./transaction-conflict.js');
  const conflict = failure('P2034');
  const operation = vi.fn().mockRejectedValue(conflict);
  await expect(withBillingConflictRetry(operation)).rejects.toBe(conflict);
  expect(operation).toHaveBeenCalledTimes(3);
  const recovered = vi
    .fn()
    .mockRejectedValueOnce(conflict)
    .mockResolvedValue('ok');
  await expect(withBillingConflictRetry(recovered)).resolves.toBe('ok');
  expect(recovered).toHaveBeenCalledTimes(2);
});
