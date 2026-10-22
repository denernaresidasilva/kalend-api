import { ForbiddenException, BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { graceEnd } from './commercial-policy.js';
import { integer } from '../common/validation.js';

/** Actor ID comes from the authenticated context, never the request body. */
export async function assertGrantActor(
  tx: Prisma.TransactionClient,
  actorId: string,
) {
  const actor = await tx.user.findUnique({ where: { id: actorId } });
  if (!actor?.isActive || !actor.isSuperAdmin)
    throw new ForbiddenException('ADMIN_GRANT_FORBIDDEN');
}
export async function createAdminGrant(
  tx: Prisma.TransactionClient,
  actorId: string,
  subscriptionId: string,
  startsAt: Date,
  endsAt: Date,
  graceDays = 0,
) {
  await assertGrantActor(tx, actorId);
  integer(graceDays, 'adminGraceDays', 0, 999);
  if (!(endsAt > startsAt))
    throw new BadRequestException('ADMIN_GRANT_PERIOD_INVALID');
  if (typeof tx.$queryRaw === 'function')
    await tx.$queryRaw`SELECT id FROM "Subscription" WHERE id = ${subscriptionId} FOR UPDATE`;
  return tx.subscriptionEntitlement.create({
    data: {
      subscriptionId,
      origin: 'ADMIN_GRANT',
      startsAt,
      endsAt,
      grantedById: actorId,
      grantedAt: new Date(),
      graceEndsAt: graceDays > 0 ? graceEnd(endsAt, graceDays) : null,
    },
  });
}
