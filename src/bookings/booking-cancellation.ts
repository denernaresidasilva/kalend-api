import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { completeWaitlistConversion } from './waitlist-conversion.js';
import { attendanceEvent } from './attendance-domain.js';
export async function cancelBookingInTx(
  tx: Prisma.TransactionClient,
  companyId: string,
  requestId: string,
  actorId: string,
  reason: string,
) {
  const request = await tx.bookingRequest.findFirst({
    where: { id: requestId, companyId },
    include: { items: true },
  });
  if (!request) throw new NotFoundException();
  if (request.status === 'CANCELLED')
    return { id: request.id, status: request.status };
  if (!['REQUESTED', 'CONFIRMED'].includes(request.status))
    throw new ConflictException('Agendamento já encerrado.');
  for (const key of [
    ...new Set(
      request.items.map((i) => companyId + ':professional:' + i.professionalId),
    ),
  ].sort())
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))::text`;
  if (
    await tx.posSale.findFirst({
      where: {
        companyId,
        bookingRequestId: requestId,
        status: { not: 'CANCELLED' },
      },
    })
  )
    throw new ConflictException(
      'Encerre a comanda no PDV antes de cancelar o agendamento.',
    );
  await tx.bookingRequest.update({
    where: { id: requestId },
    data: { status: 'CANCELLED' },
  });
  await completeWaitlistConversion(
    tx,
    companyId,
    requestId,
    request.customerId,
    'CANCELLED',
    request.items,
  );
  await attendanceEvent(
    tx,
    companyId,
    requestId,
    'CANCELLED',
    'CANCEL:' + requestId,
    actorId,
    reason,
  );
  await tx.posAudit.create({
    data: {
      companyId,
      actorId,
      action: 'BOOKING_CANCELLED',
      detail: { requestId, reason },
    },
  });
  await tx.$queryRaw`SELECT pg_notify('kalend_booking_events',${JSON.stringify({ companyId, professionalIds: request.items.map((i) => i.professionalId) })})::text`;
  return { id: requestId, status: 'CANCELLED' };
}
