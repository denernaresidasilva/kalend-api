import { Prisma } from '@prisma/client';

/** Raw FOR UPDATE queries use P2010 with pg's SQLSTATE through PrismaPg. */
export function retryableBillingConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === 'P2002' || error.code === 'P2034') return true;
  if (error.code !== 'P2010') return false;
  const adapter = error.meta?.driverAdapterError as
    { cause?: { originalCode?: string } } | undefined;
  const state = adapter?.cause?.originalCode ?? error.meta?.code;
  return state === '40001' || state === '40P01';
}

/** Retry the complete transaction, never a failed transaction's individual query. */
export async function withBillingConflictRetry<T>(
  operation: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= 2 || !retryableBillingConflict(error)) throw error;
    }
  }
}
