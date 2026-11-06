import type { Prisma } from '@prisma/client';
export async function attendance(
  tx: Prisma.TransactionClient,
  companyId: string,
  requestId: string,
) {
  const request = await tx.bookingRequest.findFirstOrThrow({
    where: { id: requestId, companyId },
    include: { items: { orderBy: { startsAt: 'asc' }, take: 1 } },
  });
  const startsAt = request.items[0]?.startsAt ?? new Date();
  return tx.bookingConfirmation.upsert({
    where: { requestId_companyId: { requestId, companyId } },
    create: { companyId, requestId, startsAt, deadlineAt: startsAt },
    update: {},
  });
}
export async function attendanceEvent(
  tx: Prisma.TransactionClient,
  companyId: string,
  requestId: string,
  type: string,
  sourceKey: string,
  actorId?: string,
  reason?: string,
) {
  const record = await attendance(tx, companyId, requestId);
  return tx.bookingAttendanceEvent.upsert({
    where: { companyId_sourceKey: { companyId, sourceKey } },
    create: {
      companyId,
      confirmationId: record.id,
      type,
      sourceKey,
      actorId,
      reason,
    },
    update: {},
  });
}
