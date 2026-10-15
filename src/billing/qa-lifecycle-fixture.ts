import { createHash } from 'node:crypto';
import { ForbiddenException, ConflictException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service.js';
import { assertCommercialQaScope } from './qa-simulation.service.js';
import {
  requireQaCommunicationAllowlist,
  allowedRecipient,
} from '../communication/qa-policy.js';
import { qaRecoverableCompany } from './company-policy.js';

/** Bootstrap only. New UUID is NOT added to any allowlist; a separate private authorization is required. */
export async function createQaLifecycleFixture(
  db: PrismaService,
  sourceCompanyId: string,
  key: string,
) {
  assertCommercialQaScope(sourceCompanyId);
  const allow = requireQaCommunicationAllowlist();
  if (!key || !/^[a-zA-Z0-9_-]{1,64}$/.test(key))
    throw new ForbiddenException('QA_FIXTURE_KEY_INVALID');
  const slug =
    'qa-billing-lifecycle-' +
    createHash('sha256')
      .update(sourceCompanyId + ':' + key)
      .digest('hex')
      .slice(0, 20);
  return db.$transaction(
    async (tx) => {
      assertCommercialQaScope(sourceCompanyId);
      const source = await tx.company.findUnique({
        where: { id: sourceCompanyId },
      });
      if (!qaRecoverableCompany(source))
        throw new ForbiddenException('QA_FIXTURE_SOURCE_BLOCKED');
      const owner = await tx.membership.findFirst({
        where: {
          companyId: sourceCompanyId,
          role: 'OWNER',
          isActive: true,
          user: { isActive: true, isSuperAdmin: false },
        },
        include: { user: true },
      });
      if (
        !owner ||
        !allowedRecipient('EMAIL', owner.user.email, 'USER', allow) ||
        !allowedRecipient('WHATSAPP', owner.user.phone ?? '', 'USER', allow)
      )
        throw new ForbiddenException('QA_FIXTURE_RECIPIENT_BLOCKED');
      const existing = await tx.company.findUnique({ where: { slug } });
      if (existing) {
        const member = await tx.membership.findUnique({
          where: {
            userId_companyId: { userId: owner.userId, companyId: existing.id },
          },
        });
        if (
          existing.name !== 'QA Billing Lifecycle' ||
          existing.administrativeStatus !== 'ACTIVE' ||
          !member ||
          member.role !== 'OWNER' ||
          !member.isActive ||
          (await tx.subscription.count({ where: { companyId: existing.id } }))
        )
          throw new ConflictException('QA_FIXTURE_ALREADY_USED');
        return {
          source: 'QA_SIMULATION',
          companyId: existing.id,
          duplicate: true,
          allowlistUpdateRequired: true,
        };
      }
      const company = await tx.company.create({
        data: {
          name: 'QA Billing Lifecycle',
          slug,
          status: 'ACTIVE',
          administrativeStatus: 'ACTIVE',
          isActive: true,
        },
      });
      await tx.membership.create({
        data: {
          companyId: company.id,
          userId: owner.userId,
          role: 'OWNER',
          isActive: true,
        },
      });
      const events = await tx.globalCommunicationOutbox.findMany({
        where: { companyId: company.id },
      });
      for (const event of events)
        await tx.globalCommunicationOutbox.update({
          where: { id: event.id },
          data: { businessKey: 'QA_SIMULATION:' + event.businessKey },
        });
      return {
        source: 'QA_SIMULATION',
        companyId: company.id,
        duplicate: false,
        allowlistUpdateRequired: true,
      };
    },
    { isolationLevel: 'Serializable' },
  );
}
