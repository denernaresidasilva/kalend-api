import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { EntitlementsService } from '../billing/entitlements.service.js';
import { OperationsService, type Operator } from './operations.service.js';
import { object, integer, string, uuid } from '../common/validation.js';
import { releasePackageUses, assertPackageSaleable } from './package-domain.js';
import { reconcileCommissions } from './commission-domain.js';
import { queueCustomerEvent } from './operational-messages.js';
import { netReceived, proportionFloor } from './pos-domain.js';
import { reverseLoyalty } from './loyalty-domain.js';
@Injectable()
export class PackagesService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(OperationsService) private readonly ops: OperationsService,
    @Inject(EntitlementsService)
    private readonly entitlements: EntitlementsService,
  ) {}
  async status(actor: Operator) {
    const sub = await this.entitlements.current(actor.companyId);
    return {
      entitled: sub.plan.features.some(
        (f) => f.code === 'packages' && f.enabled,
      ),
      recurringExternalStatus: 'DEPENDENCIA_EXTERNA',
    };
  }
  async definitions(actor: Operator) {
    return this.db.posPackageDefinition.findMany({
      where: { companyId: actor.companyId },
      include: {
        product: { select: { id: true, priceCents: true } },
        services: {
          include: {
            service: { select: { name: true } },
            professionals: { select: { professionalId: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }
  async create(actor: Operator, input: unknown) {
    const b = object(input, [
      'name',
      'description',
      'priceCents',
      'validityDays',
      'terms',
      'services',
    ]);
    const name = string(b.name, 'name', 120),
      description = string(b.description, 'description', 2000),
      terms = string(b.terms, 'terms', 2000);
    integer(b.priceCents, 'priceCents', 1, 100000000);
    integer(b.validityDays, 'validityDays', 1, 3650);
    if (
      !Array.isArray(b.services) ||
      !b.services.length ||
      b.services.length > 20
    )
      throw new BadRequestException('Informe até 20 serviços.');
    const items = b.services.map((raw) => {
      const i = object(raw, ['serviceId', 'sessions', 'professionalIds']);
      integer(i.sessions, 'sessions', 1, 100);
      if (!Array.isArray(i.professionalIds) || i.professionalIds.length > 100)
        throw new BadRequestException('Profissionais inválidos.');
      return {
        serviceId: uuid(i.serviceId),
        sessions: i.sessions as number,
        professionalIds: [...new Set(i.professionalIds.map(uuid))],
      };
    });
    if (
      new Set(items.map((i) => i.serviceId)).size !== items.length ||
      items.reduce((n, i) => n + i.sessions, 0) > 100
    )
      throw new BadRequestException(
        'Serviços duplicados ou mais de 100 sessões.',
      );
    return this.ops.change(actor, ['OWNER', 'ADMIN'], async (tx) => {
      await this.entitlements.assertFeature(actor.companyId, 'packages', tx);
      if (
        (await tx.posPackageDefinition.count({
          where: { companyId: actor.companyId, active: true },
        })) >= 200
      )
        throw new ConflictException(
          'Limite de 200 definições de pacotes ativas.',
        );
      const snapshots = [];
      for (const i of items) {
        const service = await tx.service.findFirst({
          where: { id: i.serviceId, companyId: actor.companyId, active: true },
        });
        if (!service) throw new NotFoundException('Serviço não encontrado.');
        if (i.professionalIds.length) {
          const eligible = await tx.professionalProfile.count({
            where: {
              companyId: actor.companyId,
              id: { in: i.professionalIds },
              active: true,
              membership: {
                isActive: true,
                role: { in: ['OWNER', 'ADMIN', 'PROFESSIONAL'] },
              },
              services: { some: { serviceId: service.id } },
            },
          });
          if (eligible !== i.professionalIds.length)
            throw new BadRequestException(
              'Profissional não habilitado no serviço.',
            );
        }
        snapshots.push({ ...i, listPriceCents: service.priceCents });
      }
      const product = await tx.posProduct.create({
        data: {
          companyId: actor.companyId,
          name: 'Pacote: ' + name,
          priceCents: b.priceCents as number,
        },
      });
      const definition = await tx.posPackageDefinition.create({
        data: {
          companyId: actor.companyId,
          productId: product.id,
          name,
          description,
          validityDays: b.validityDays as number,
          terms,
        },
      });
      for (const i of snapshots) {
        const item = await tx.posPackageService.create({
          data: {
            companyId: actor.companyId,
            definitionId: definition.id,
            serviceId: i.serviceId,
            sessions: i.sessions,
            listPriceCents: i.listPriceCents,
          },
        });
        if (i.professionalIds.length)
          await tx.posPackageProfessional.createMany({
            data: i.professionalIds.map((professionalId) => ({
              companyId: actor.companyId,
              packageServiceId: item.id,
              professionalId,
            })),
          });
      }
      await tx.posAudit.create({
        data: {
          companyId: actor.companyId,
          actorId: actor.userId,
          action: 'PACKAGE_DEFINED',
          detail: { definitionId: definition.id, productId: product.id },
        },
      });
      return { ...definition, productId: product.id };
    });
  }
  async deactivate(actor: Operator, id: string) {
    return this.ops.change(actor, ['OWNER', 'ADMIN'], async (tx) => {
      const row = await tx.posPackageDefinition.findFirst({
        where: { id, companyId: actor.companyId },
      });
      if (!row) throw new NotFoundException();
      await tx.posProduct.update({
        where: { id: row.productId },
        data: { active: false },
      });
      const result = await tx.posPackageDefinition.update({
        where: { id },
        data: { active: false },
      });
      await tx.posAudit.create({
        data: {
          companyId: actor.companyId,
          actorId: actor.userId,
          action: 'PACKAGE_DEACTIVATED',
          detail: { definitionId: id },
        },
      });
      return result;
    });
  }
  async wallets(actor: Operator, own = false, customerIdValue?: unknown) {
    const customer = own
      ? await this.db.customerProfile.findFirst({
          where: { companyId: actor.companyId, userId: actor.userId },
        })
      : null;
    if (own && !customer) return [];
    const rows = await this.db.posPackageWallet.findMany({
      where: {
        companyId: actor.companyId,
        ...(own
          ? { customerId: customer!.id }
          : customerIdValue
            ? { customerId: uuid(customerIdValue) }
            : {}),
      },
      include: {
        sourceSale: {
          select: {
            totalCents: true,
            payments: { select: { amountCents: true } },
            refunds: { select: { amountCents: true } },
          },
        },
        definition: { select: { name: true, terms: true, refundPolicy: true } },
        customer: { select: { id: true, name: true } },
        sessions: { include: { service: { select: { name: true } } } },
        movements: {
          select: {
            id: true,
            type: true,
            units: true,
            reason: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 100,
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return rows.map((w) => {
      const sourceNet = Math.max(
          0,
          Math.min(
            w.sourceSale.totalCents,
            netReceived(w.sourceSale.payments, w.sourceSale.refunds),
          ),
        ),
        fundedCents = w.sourceSale.totalCents
          ? proportionFloor(w.originalCents, sourceNet, w.sourceSale.totalCents)
          : 0,
        consumedValue = w.sessions
          .filter((s) => s.state === 'CONSUMED')
          .reduce((n, s) => n + s.valueCents, 0);
      return {
        ...w,
        status:
          w.status === 'ACTIVE' && w.expiresAt <= new Date()
            ? 'EXPIRED'
            : w.status,
        fundedCents,
        recoveryCents: Math.max(0, consumedValue - fundedCents),
        usable: w.status === 'ACTIVE' && w.expiresAt > new Date(),
        available:
          w.status === 'ACTIVE' && w.expiresAt > new Date()
            ? w.sessions.filter((s) => s.state === 'AVAILABLE').length
            : 0,
        reserved: w.sessions.filter((s) => s.state === 'RESERVED').length,
        consumed: w.sessions.filter((s) => s.state === 'CONSUMED').length,
      };
    });
  }
  async sell(actor: Operator, input: unknown) {
    const b = object(input, ['definitionId', 'customerId', 'idempotencyKey']),
      definitionId = uuid(b.definitionId),
      customerId = uuid(b.customerId),
      key = uuid(b.idempotencyKey),
      requestHash = createHash('sha256')
        .update(
          JSON.stringify({ purpose: 'PACKAGE', definitionId, customerId }),
        )
        .digest('hex');
    return this.ops.change(
      actor,
      ['OWNER', 'ADMIN', 'RECEPTIONIST'],
      async (tx) => {
        await this.entitlements.assertFeature(actor.companyId, 'packages', tx);
        const old = await tx.posSale.findUnique({
          where: {
            companyId_idempotencyKey: {
              companyId: actor.companyId,
              idempotencyKey: key,
            },
          },
        });
        if (old) {
          if (old.requestHash !== requestHash)
            throw new ConflictException('Chave já utilizada.');
          return this.ops.sale(tx, actor, old.id);
        }
        const definition = await tx.posPackageDefinition.findFirst({
          where: {
            id: definitionId,
            companyId: actor.companyId,
            active: true,
            product: { active: true },
          },
          include: { product: true },
        });
        if (
          !definition ||
          !(await tx.customerProfile.findFirst({
            where: { id: customerId, companyId: actor.companyId },
          }))
        )
          throw new NotFoundException('Pacote ou cliente não encontrado.');
        await assertPackageSaleable(tx, actor.companyId, definition.productId);
        const sale = await tx.posSale.create({
          data: {
            companyId: actor.companyId,
            customerId,
            idempotencyKey: key,
            requestHash,
            openedById: actor.userId,
          },
        });
        await tx.posSaleLine.create({
          data: {
            companyId: actor.companyId,
            saleId: sale.id,
            productId: definition.productId,
            name: definition.product.name,
            unitPriceCents: definition.product.priceCents,
            quantity: 1,
          },
        });
        await this.ops.recalculate(tx, await this.ops.sale(tx, actor, sale.id));
        await tx.posAudit.create({
          data: {
            companyId: actor.companyId,
            saleId: sale.id,
            actorId: actor.userId,
            action: 'PACKAGE_SALE_OPENED',
            detail: { definitionId, customerId },
          },
        });
        await this.ops.notify(tx, actor.companyId);
        return this.ops.sale(tx, actor, sale.id);
      },
    );
  }
  async reserve(actor: Operator, lineId: string, input: unknown) {
    const b = object(input, ['sessionId', 'idempotencyKey']),
      sessionId = uuid(b.sessionId),
      key = uuid(b.idempotencyKey),
      hash = createHash('sha256')
        .update(JSON.stringify({ lineId, sessionId }))
        .digest('hex');
    return this.ops.change(
      actor,
      ['OWNER', 'ADMIN', 'RECEPTIONIST'],
      async (tx) => {
        await this.entitlements.assertFeature(actor.companyId, 'packages', tx);
        const old = await tx.posPackageUse.findUnique({
          where: {
            companyId_idempotencyKey: {
              companyId: actor.companyId,
              idempotencyKey: key,
            },
          },
        });
        if (old) {
          if (old.requestHash !== hash)
            throw new ConflictException('Chave já utilizada.');
          return old;
        }
        const line = await tx.posSaleLine.findFirst({
          where: { id: lineId, companyId: actor.companyId, voidedAt: null },
        });
        if (
          !line ||
          !line.serviceId ||
          !line.professionalId ||
          line.quantity !== 1
        )
          throw new BadRequestException('Use uma sessão por item de serviço.');
        const sale = await this.ops.sale(tx, actor, line.saleId);
        this.ops.assertEditable(sale);
        if (
          !(await tx.professionalProfile.findFirst({
            where: {
              id: line.professionalId,
              companyId: actor.companyId,
              active: true,
              membership: {
                isActive: true,
                role: { in: ['OWNER', 'ADMIN', 'PROFESSIONAL'] },
              },
              services: { some: { serviceId: line.serviceId } },
            },
          }))
        )
          throw new ConflictException(
            'Profissional não habilitado para o serviço.',
          );
        const session = await tx.posPackageSession.findFirst({
          where: {
            id: sessionId,
            companyId: actor.companyId,
            state: 'AVAILABLE',
            serviceId: line.serviceId,
            wallet: {
              customerId: sale.customerId ?? '',
              status: 'ACTIVE',
              expiresAt: { gt: new Date() },
              sourceSale: { status: 'PAID' },
            },
          },
          include: { wallet: true },
        });
        if (
          !session ||
          (session.eligibleProfessionalIds.length &&
            !session.eligibleProfessionalIds.includes(line.professionalId))
        )
          throw new ConflictException(
            'Sessão não disponível para este cliente, serviço ou profissional.',
          );
        if (
          await tx.posPackageUse.findFirst({
            where: {
              companyId: actor.companyId,
              lineId,
              status: { in: ['RESERVED', 'CONSUMED'] },
            },
          })
        )
          throw new ConflictException('O serviço já possui uma sessão.');
        const active = await tx.posPackageUse.aggregate({
          where: {
            companyId: actor.companyId,
            saleId: sale.id,
            status: { in: ['RESERVED', 'CONSUMED'] },
          },
          _sum: { allocatedCents: true },
        });
        if (
          (active._sum.allocatedCents ?? 0) +
            session.valueCents +
            Math.max(0, sale.totalCents - line.unitPriceCents) >
          1000000000
        )
          throw new BadRequestException(
            'Limite do valor econômico da comanda excedido.',
          );
        const use = await tx.posPackageUse.create({
          data: {
            companyId: actor.companyId,
            sessionId,
            saleId: sale.id,
            lineId,
            originalUnitPriceCents: line.unitPriceCents,
            allocatedCents: session.valueCents,
            idempotencyKey: key,
            requestHash: hash,
          },
        });
        await tx.posPackageSession.update({
          where: { id: sessionId },
          data: { state: 'RESERVED' },
        });
        await tx.posSaleLine.update({
          where: { id: lineId },
          data: { unitPriceCents: 0 },
        });
        await this.ops.recalculate(tx, await this.ops.sale(tx, actor, sale.id));
        await tx.posPackageMovement.create({
          data: {
            companyId: actor.companyId,
            walletId: session.walletId,
            useId: use.id,
            type: 'RESERVE',
            sourceKey: 'RESERVE:' + use.id,
            units: 0,
            actorId: actor.userId,
            reason:
              'Sessão selecionada; consumo somente após atendimento concluído e finalização.',
          },
        });
        await this.ops.notify(tx, actor.companyId, [line.professionalId]);
        return use;
      },
    );
  }
  async release(actor: Operator, useId: string, input: unknown) {
    const b = object(input, ['reason']),
      reason = string(b.reason, 'reason', 1000);
    return this.ops.change(
      actor,
      ['OWNER', 'ADMIN', 'RECEPTIONIST'],
      async (tx) => {
        const use = await tx.posPackageUse.findFirst({
          where: { id: useId, companyId: actor.companyId },
        });
        if (!use) throw new NotFoundException();
        if (use.status === 'RELEASED') return use;
        if (use.status !== 'RESERVED')
          throw new ConflictException('A sessão já foi consumida.');
        const sale = await this.ops.sale(tx, actor, use.saleId);
        this.ops.assertEditable(sale);
        await releasePackageUses(tx, actor, sale.id, reason, use.lineId, true);
        await this.ops.recalculate(tx, await this.ops.sale(tx, actor, sale.id));
        await this.ops.notify(
          tx,
          actor.companyId,
          sale.lines.flatMap((l) =>
            l.professionalId ? [l.professionalId] : [],
          ),
        );
        return { ...use, status: 'RELEASED' };
      },
    );
  }
  async restore(actor: Operator, useId: string, input: unknown) {
    const b = object(input, ['reason', 'idempotencyKey']),
      reason = string(b.reason, 'reason', 1000),
      key = uuid(b.idempotencyKey);
    return this.ops.change(actor, ['OWNER', 'ADMIN'], async (tx) => {
      const old = await tx.posPackageMovement.findUnique({
        where: {
          companyId_sourceKey: {
            companyId: actor.companyId,
            sourceKey: 'RESTORE:' + key,
          },
        },
      });
      if (old) {
        if (old.useId !== useId || old.reason !== reason)
          throw new ConflictException('Chave já utilizada.');
        return old;
      }
      const use = await tx.posPackageUse.findFirst({
        where: { id: useId, companyId: actor.companyId, status: 'CONSUMED' },
        include: { session: { include: { wallet: true } } },
      });
      if (
        !use ||
        use.session.wallet.status !== 'ACTIVE' ||
        use.session.wallet.expiresAt <= new Date()
      )
        throw new ConflictException('Sessão não restaurável.');
      const sale = await this.ops.sale(tx, actor, use.saleId);
      if (sale.totalCents !== 0 || sale.payments.length)
        throw new ConflictException(
          'Revisão automática disponível somente para comanda integralmente coberta por pacote, sem recebimento em dinheiro.',
        );
      await tx.posPackageUse.update({
        where: { id: use.id },
        data: { status: 'REVERSED' },
      });
      await tx.posPackageSession.update({
        where: { id: use.sessionId },
        data: { state: 'AVAILABLE' },
      });
      const remaining = await tx.posPackageUse.count({
        where: {
          companyId: actor.companyId,
          saleId: sale.id,
          status: 'CONSUMED',
        },
      });
      await tx.posSale.update({
        where: { id: sale.id },
        data: { status: remaining ? 'PARTIALLY_REFUNDED' : 'REFUNDED' },
      });
      const row = await tx.posPackageMovement.create({
        data: {
          companyId: actor.companyId,
          walletId: use.session.walletId,
          useId: use.id,
          type: 'RESTORE',
          sourceKey: 'RESTORE:' + key,
          units: 1,
          actorId: actor.userId,
          reason,
        },
      });
      await reconcileCommissions(tx, actor, sale, 'PACKAGE_RESTORE:' + key);
      await reverseLoyalty(tx, sale, 'PACKAGE_RESTORE:' + key);
      await tx.posFollowupJob.updateMany({
        where: {
          companyId: actor.companyId,
          saleId: sale.id,
          status: 'PENDING',
        },
        data: { status: 'CANCELLED', result: 'PACKAGE_SESSION_RESTORED' },
      });
      await tx.posAudit.create({
        data: {
          companyId: actor.companyId,
          saleId: sale.id,
          actorId: actor.userId,
          action: 'PACKAGE_SESSION_RESTORED_NO_CASH_REFUND',
          detail: { useId, reason },
        },
      });
      await queueCustomerEvent(
        tx,
        actor.companyId,
        use.session.wallet.customerId,
        'OP_PACKAGE_RESTORED',
        use.id,
        {
          __saleId: sale.id,
          __packageUseId: use.id,
          servico: 'Sessão de pacote restaurada por revisão autorizada',
        },
      );
      await this.ops.notify(
        tx,
        actor.companyId,
        sale.lines.flatMap((l) => (l.professionalId ? [l.professionalId] : [])),
      );
      return row;
    });
  }
}
