import { Inject } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
@Injectable()
export class LifecycleService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}
  /** Explicit maintenance command; reads never silently mutate status. */
  async reconcile() {
    const now = new Date();
    return this.prisma.$transaction(
      async (tx) => {
        const expired = await tx.subscription.findMany({
          where: {
            OR: [
              { status: 'TRIALING', trialEndsAt: { lte: now } },
              { status: 'ACTIVE', currentPeriodEnd: { lte: now } },
            ],
          },
          select: { id: true, companyId: true },
        });
        const result = await tx.subscription.updateMany({
          where: { id: { in: expired.map((s) => s.id) } },
          data: { status: 'EXPIRED', endedAt: now },
        });
        for (const companyId of new Set(expired.map((s) => s.companyId))) {
          const valid = await tx.subscription.count({
            where: {
              companyId,
              OR: [
                { status: 'ACTIVE', currentPeriodEnd: { gt: now } },
                { status: 'TRIALING', trialEndsAt: { gt: now } },
              ],
            },
          });
          if (!valid)
            await tx.company.updateMany({
              where: { id: companyId, status: { in: ['ACTIVE', 'TRIAL'] } },
              data: { status: 'SUSPENDED', isActive: false },
            });
        }
        return { expired: result.count, reconciledAt: now };
      },
      { isolationLevel: 'Serializable' },
    );
  }
}
