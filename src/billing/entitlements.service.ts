import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { entitledWhere } from './commercial-policy.js';
@Injectable()
export class EntitlementsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}
  async current(companyId: string, tx: Prisma.TransactionClient = this.prisma) {
    const sub = await tx.subscription.findFirst({
      where: entitledWhere(companyId),
      include: { plan: { include: { features: true } } },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    });
    if (!sub)
      throw new ForbiddenException({
        code: 'SUBSCRIPTION_REQUIRED',
        regularizationRequired: true,
      });
    return sub;
  }
  /** Call inside the SAME serializable transaction as resource creation; current comes from DB, never HTTP. */
  async assertLimit(
    tx: Prisma.TransactionClient,
    companyId: string,
    feature: 'professionals' | 'clients' | 'units' | 'messages',
    current: number,
    increment = 1,
  ) {
    if (
      !Number.isSafeInteger(current) ||
      current < 0 ||
      !Number.isSafeInteger(increment) ||
      increment < 1
    )
      throw new ForbiddenException('INVALID_PLAN_USAGE');
    const sub = await this.current(companyId, tx);
    const key = {
      professionals: 'maxProfessionals',
      clients: 'maxClients',
      units: 'maxUnits',
      messages: 'maxMessages',
    } as const;
    const limit = sub.plan[key[feature]];
    if (limit !== null && current + increment > limit)
      throw new ForbiddenException({
        code: 'PLAN_LIMIT_REACHED',
        feature,
        current,
        limit,
        upgradeRequired: true,
      });
  }
  async assertFeature(
    companyId: string,
    feature: string,
    tx: Prisma.TransactionClient = this.prisma,
  ) {
    const sub = await this.current(companyId, tx);
    if (!sub.plan.features.some((f) => f.code === feature && f.enabled))
      throw new ForbiddenException({
        code: 'PLAN_FEATURE_UNAVAILABLE',
        feature,
        upgradeRequired: true,
      });
  }
  /** Existing Membership model supports actual DB counts; unit/message resources don't exist yet. */
  async assertMembershipLimit(
    tx: Prisma.TransactionClient,
    companyId: string,
    role: 'PROFESSIONAL' | 'CLIENT',
  ) {
    const current = await tx.membership.count({
      where: { companyId, role, isActive: true },
    });
    return this.assertLimit(
      tx,
      companyId,
      role === 'PROFESSIONAL' ? 'professionals' : 'clients',
      current,
    );
  }
}
