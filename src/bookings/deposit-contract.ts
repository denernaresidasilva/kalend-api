import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  OperationsService,
  type Operator,
} from '../operations/operations.service.js';
import { integer, object, uuid } from '../common/validation.js';
import { proportionFloor } from '../operations/pos-domain.js';
export interface MerchantDepositProvider {
  readonly provider: string;
  readonly environment: 'SANDBOX' | 'PRODUCTION';
  create(input: {
    companyId: string;
    bookingRequestId: string;
    idempotencyKey: string;
    amountCents: number;
    currency: 'BRL';
  }): Promise<{ externalId: string; status: 'PENDING'; checkoutUrl: string }>;
  verify(input: {
    companyId: string;
    externalId: string;
  }): Promise<{
    status: 'PENDING' | 'CONFIRMED' | 'REFUNDED';
    amountCents: number;
    currency: 'BRL';
    evidenceId: string;
  }>;
}
/** SaaS gateway credentials cannot serve as merchant collection authorization. */
export class UnavailableMerchantDepositProvider implements MerchantDepositProvider {
  readonly provider = 'UNCONFIGURED';
  readonly environment = 'SANDBOX' as const;
  create(
    _input: Parameters<MerchantDepositProvider['create']>[0],
  ): ReturnType<MerchantDepositProvider['create']> {
    return Promise.reject(
      new ServiceUnavailableException('MERCHANT_GATEWAY_NOT_HOMOLOGATED'),
    );
  }
  verify(
    _input: Parameters<MerchantDepositProvider['verify']>[0],
  ): ReturnType<MerchantDepositProvider['verify']> {
    return Promise.reject(
      new ServiceUnavailableException('MERCHANT_GATEWAY_NOT_HOMOLOGATED'),
    );
  }
}
export function depositAmount(
  priceCents: number,
  rule: { percentBps: number | null; fixedCents: number | null },
) {
  integer(priceCents, 'priceCents', 0, 100000000);
  if ((rule.percentBps === null) === (rule.fixedCents === null))
    throw new BadRequestException('Escolha percentual ou valor fixo.');
  if (rule.percentBps !== null)
    integer(rule.percentBps, 'percentBps', 1, 10000);
  if (rule.fixedCents !== null)
    integer(rule.fixedCents, 'fixedCents', 1, 100000000);
  return Math.min(
    priceCents,
    rule.percentBps !== null
      ? proportionFloor(priceCents, rule.percentBps, 10000)
      : rule.fixedCents!,
  );
}
@Injectable()
export class DepositPoliciesService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(OperationsService) private readonly ops: OperationsService,
  ) {}
  async list(actor: Operator) {
    return {
      providerStatus: 'DEPENDENCIA_EXTERNA',
      canCollect: false,
      policies: await this.db.bookingDepositPolicy.findMany({
        where: { companyId: actor.companyId },
        include: {
          service: { select: { name: true, priceCents: true } },
          professional: { select: { displayName: true } },
        },
      }),
    };
  }
  async draft(actor: Operator, input: unknown) {
    const b = object(input, [
      'serviceId',
      'professionalId',
      'percentBps',
      'fixedCents',
      'enabled',
    ]);
    if (b.enabled !== false)
      throw new ServiceUnavailableException('MERCHANT_GATEWAY_NOT_HOMOLOGATED');
    const serviceId = uuid(b.serviceId),
      professionalId = b.professionalId ? uuid(b.professionalId) : null,
      percentBps = b.percentBps === undefined ? null : (b.percentBps as number),
      fixedCents = b.fixedCents === undefined ? null : (b.fixedCents as number);
    return this.ops.change(actor, ['OWNER', 'ADMIN'], async (tx) => {
      const service = await tx.service.findFirst({
        where: { id: serviceId, companyId: actor.companyId },
      });
      if (!service) throw new NotFoundException();
      if (
        professionalId &&
        !(await tx.serviceProfessional.findFirst({
          where: { companyId: actor.companyId, serviceId, professionalId },
        }))
      )
        throw new BadRequestException('Profissional não habilitado.');
      const amount = depositAmount(service.priceCents, {
        percentBps,
        fixedCents,
      });
      const old = await tx.bookingDepositPolicy.findFirst({
        where: { companyId: actor.companyId, serviceId, professionalId },
      });
      const data = { percentBps, fixedCents, enabled: false };
      const row = old
        ? await tx.bookingDepositPolicy.update({ where: { id: old.id }, data })
        : await tx.bookingDepositPolicy.create({
            data: {
              companyId: actor.companyId,
              serviceId,
              professionalId,
              ...data,
            },
          });
      await tx.posAudit.create({
        data: {
          companyId: actor.companyId,
          actorId: actor.userId,
          action: 'DEPOSIT_POLICY_DRAFTED',
          detail: { policyId: row.id, amountCents: amount, canCollect: false },
        },
      });
      return {
        policy: row,
        quote: {
          servicePriceCents: service.priceCents,
          depositCents: amount,
          balanceCents: service.priceCents - amount,
        },
        canCollect: false,
        providerStatus: 'DEPENDENCIA_EXTERNA',
      };
    });
  }
}
