import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { OperationsService, type Operator } from './operations.service.js';
import { EntitlementsService } from '../billing/entitlements.service.js';
import { object, integer, string, uuid } from '../common/validation.js';
import { localMinuteToUtc } from '../bookings/booking-domain.js';
import { takeInventory } from './inventory-domain.js';
const managers = ['OWNER', 'ADMIN'],
  readers = [...managers, 'RECEPTIONIST', 'ACCOUNTANT'];
const hash = (v: Record<string, unknown>) =>
  createHash('sha256')
    .update(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
        ),
      ),
    )
    .digest('hex');
@Injectable()
export class InventoryService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(OperationsService) private readonly ops: OperationsService,
    @Inject(EntitlementsService)
    private readonly entitlements: EntitlementsService,
  ) {}
  private async write<T>(
    actor: Operator,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ) {
    return this.ops.change(actor, managers, async (tx) => {
      await this.entitlements.assertFeature(actor.companyId, 'inventory', tx);
      return work(tx);
    });
  }
  async reference(actor: Operator, input: unknown) {
    const b = object(input, ['type', 'name', 'contact']),
      name = string(b.name, 'name', 120),
      contact =
        b.contact === undefined ? '' : string(b.contact, 'contact', 300);
    if (b.type !== 'CATEGORY' && b.type !== 'SUPPLIER')
      throw new BadRequestException('Tipo inválido.');
    return this.write(actor, (tx) =>
      b.type === 'CATEGORY'
        ? tx.posInventoryCategory.upsert({
            where: { companyId_name: { companyId: actor.companyId, name } },
            create: { companyId: actor.companyId, name },
            update: {},
          })
        : tx.posInventorySupplier.upsert({
            where: { companyId_name: { companyId: actor.companyId, name } },
            create: { companyId: actor.companyId, name, contact },
            update: { contact },
          }),
    );
  }
  async configure(actor: Operator, id: string, input: unknown) {
    const b = object(input, [
      'stockManaged',
      'minimumMilli',
      'costCents',
      'unit',
      'barcode',
      'location',
      'categoryId',
      'priceCents',
      'reason',
    ]);
    if (typeof b.stockManaged !== 'boolean')
      throw new BadRequestException('Controle de estoque inválido.');
    integer(b.minimumMilli, 'minimumMilli', 0, 1000000000);
    integer(b.costCents, 'costCents', 0, 100000000);
    integer(b.priceCents, 'priceCents', 0, 100000000);
    const unit = string(b.unit, 'unit', 16).toUpperCase(),
      location = b.location ? string(b.location, 'location', 160) : '',
      reason = string(b.reason, 'reason', 1000),
      barcode = b.barcode ? string(b.barcode, 'barcode', 80) : null,
      categoryId = b.categoryId ? uuid(b.categoryId) : null;
    return this.write(actor, async (tx) => {
      const product = await tx.posProduct.findFirst({
        where: { id, companyId: actor.companyId },
        include: { packageDefinition: true, giftCard: true },
      });
      if (!product) throw new NotFoundException();
      if (product.packageDefinition || product.giftCard)
        throw new ConflictException(
          'Créditos pré-pagos não são estoque físico.',
        );
      if (
        categoryId &&
        !(await tx.posInventoryCategory.findFirst({
          where: { id: categoryId, companyId: actor.companyId },
        }))
      )
        throw new NotFoundException('Categoria não encontrada.');
      if (
        product.unit !== unit &&
        (await tx.posInventoryLot.count({
          where: { companyId: actor.companyId, productId: id },
        }))
      )
        throw new ConflictException(
          'Unidade de medida possui histórico e não pode ser alterada.',
        );
      if (
        !b.stockManaged &&
        (product.stockMilli ||
          (await tx.posServiceMaterial.count({
            where: { companyId: actor.companyId, productId: id },
          })))
      )
        throw new ConflictException(
          'Zere o estoque com motivo e remova vínculos antes de desativar.',
        );
      const row = await tx.posProduct.update({
        where: { id },
        data: {
          stockManaged: b.stockManaged as boolean,
          minimumMilli: b.minimumMilli as number,
          costCents: b.costCents as number,
          priceCents: b.priceCents as number,
          unit,
          location,
          barcode,
          categoryId,
        },
      });
      await tx.posAudit.create({
        data: {
          companyId: actor.companyId,
          actorId: actor.userId,
          action: 'INVENTORY_PRODUCT_CONFIGURED',
          detail: {
            productId: id,
            reason,
            unit,
            stockManaged: b.stockManaged as boolean,
          },
        },
      });
      await this.ops.notify(tx, actor.companyId);
      return row;
    });
  }
  async recipe(actor: Operator, serviceId: string, input: unknown) {
    const b = object(input, ['materials', 'reason']),
      reason = string(b.reason, 'reason', 1000);
    if (!Array.isArray(b.materials) || b.materials.length > 30)
      throw new BadRequestException('Limite de 30 materiais por serviço.');
    const materials = b.materials.map((raw) => {
      const r = object(raw, ['productId', 'quantityMilli']);
      integer(r.quantityMilli, 'quantityMilli', 1, 100000000);
      return {
        productId: uuid(r.productId),
        quantityMilli: r.quantityMilli as number,
      };
    });
    if (new Set(materials.map((m) => m.productId)).size !== materials.length)
      throw new BadRequestException('Material repetido.');
    return this.write(actor, async (tx) => {
      if (
        !(await tx.service.findFirst({
          where: { id: serviceId, companyId: actor.companyId },
        }))
      )
        throw new NotFoundException();
      for (const m of materials)
        if (
          !(await tx.posProduct.findFirst({
            where: {
              id: m.productId,
              companyId: actor.companyId,
              stockManaged: true,
              active: true,
            },
          }))
        )
          throw new ConflictException(
            'Material indisponível ou sem controle de estoque.',
          );
      await tx.posServiceMaterial.deleteMany({
        where: { companyId: actor.companyId, serviceId },
      });
      if (materials.length)
        await tx.posServiceMaterial.createMany({
          data: materials.map((m) => ({
            ...m,
            companyId: actor.companyId,
            serviceId,
          })),
        });
      await tx.posAudit.create({
        data: {
          companyId: actor.companyId,
          actorId: actor.userId,
          action: 'SERVICE_MATERIALS_CHANGED',
          detail: { serviceId, reason, materials },
        },
      });
      return { serviceId, materials };
    });
  }
  async move(actor: Operator, input: unknown) {
    const b = object(input, [
        'productId',
        'type',
        'quantityMilli',
        'countedMilli',
        'unitCostCents',
        'supplierId',
        'lotCode',
        'expiresOn',
        'reason',
        'idempotencyKey',
      ]),
      key = uuid(b.idempotencyKey),
      productId = uuid(b.productId),
      reason = string(b.reason, 'reason', 1000);
    if (
      ![
        'ENTRY',
        'INTERNAL',
        'ADJUST_IN',
        'ADJUST_OUT',
        'LOSS',
        'INVENTORY',
      ].includes(typeof b.type === 'string' ? b.type : '')
    )
      throw new BadRequestException('Movimento inválido.');
    if (b.type === 'INVENTORY')
      integer(b.countedMilli, 'countedMilli', 0, 1000000000);
    else integer(b.quantityMilli, 'quantityMilli', 1, 1000000000);
    if (b.unitCostCents !== undefined)
      integer(b.unitCostCents, 'unitCostCents', 0, 100000000);
    return this.write(actor, async (tx) => {
      const requestHash = hash(b),
        previous = await tx.posInventoryOperation.findUnique({
          where: {
            companyId_sourceKey: { companyId: actor.companyId, sourceKey: key },
          },
        });
      if (previous) {
        if (previous.requestHash !== requestHash)
          throw new ConflictException('Chave já utilizada.');
        return { id: previous.id };
      }
      const product = await tx.posProduct.findFirst({
        where: {
          id: productId,
          companyId: actor.companyId,
          stockManaged: true,
        },
      });
      if (!product)
        throw new NotFoundException('Produto controlado não encontrado.');
      const quantity =
        b.type === 'INVENTORY'
          ? (b.countedMilli as number) - product.stockMilli
          : (['ENTRY', 'ADJUST_IN'].includes(String(b.type)) ? 1 : -1) *
            (b.quantityMilli as number);
      if(product.stockMilli+quantity>1000000000)throw new ConflictException('Limite de saldo do produto atingido.');
      const op = await tx.posInventoryOperation.create({
        data: {
          companyId: actor.companyId,
          sourceKey: key,
          requestHash,
          type: String(b.type),
          actorId: actor.userId,
          reason,
        },
      });
      if (quantity > 0) {
        const supplierId = b.supplierId ? uuid(b.supplierId) : null;
        if (
          supplierId &&
          !(await tx.posInventorySupplier.findFirst({
            where: { id: supplierId, companyId: actor.companyId },
          }))
        )
          throw new NotFoundException('Fornecedor não encontrado.');
        let expiresAt: Date | null = null;
        if (b.expiresOn) {
          const date = string(b.expiresOn, 'expiresOn', 10),
            parsed = new Date(date + 'T12:00:00Z');
          if (
            !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
            !Number.isFinite(parsed.getTime()) ||
            parsed.toISOString().slice(0, 10) !== date
          )
            throw new BadRequestException('Validade inválida.');
          parsed.setUTCDate(parsed.getUTCDate() + 1);
          expiresAt = localMinuteToUtc(
            parsed.toISOString().slice(0, 10),
            0,
            (
              await tx.company.findUniqueOrThrow({
                where: { id: actor.companyId },
                select: { timezone: true },
              })
            ).timezone,
          );
        }
        const cost = (b.unitCostCents ?? product.costCents) as number,
          lot = await tx.posInventoryLot.create({
            data: {
              companyId: actor.companyId,
              productId,
              supplierId,
              code: b.lotCode
                ? string(b.lotCode, 'lotCode', 100)
                : 'Entrada ' + op.id.slice(0, 8),
              expiresAt,
              quantityMilli: quantity,
              unitCostCents: cost,
            },
          });
        await tx.posProduct.update({
          where: { id: productId },
          data: { stockMilli: { increment: quantity } },
        });
        await tx.posInventoryMovement.create({
          data: {
            companyId: actor.companyId,
            operationId: op.id,
            lotId: lot.id,
            quantityMilli: quantity,
            costMilliCents: BigInt(quantity) * BigInt(cost),
          },
        });
      } else if (quantity < 0)
        await takeInventory(tx, {
          companyId: actor.companyId,
          productId,
          quantityMilli: -quantity,
          operationId: op.id,
          includeExpired: ['LOSS', 'ADJUST_OUT', 'INVENTORY'].includes(
            String(b.type),
          ),
        });
      await this.ops.notify(tx, actor.companyId);
      return { id: op.id };
    });
  }
  async restore(actor: Operator, id: string, input: unknown) {
    const b = object(input, ['quantityMilli', 'reason', 'idempotencyKey']),
      key = uuid(b.idempotencyKey),
      reason = string(b.reason, 'reason', 1000);
    integer(b.quantityMilli, 'quantityMilli', 1, 1000000000);
    return this.write(actor, async (tx) => {
      const requestHash = hash({ id, ...b }),
        old = await tx.posInventoryOperation.findUnique({
          where: {
            companyId_sourceKey: { companyId: actor.companyId, sourceKey: key },
          },
        });
      if (old) {
        if (old.requestHash !== requestHash)
          throw new ConflictException('Chave já utilizada.');
        return { id: old.id };
      }
      const original = await tx.posInventoryMovement.findFirst({
        where: { id, companyId: actor.companyId, quantityMilli: { lt: 0 } },
        include: { lot: true, returns: true },
      });
      if (
        !original ||
        original.returns.reduce((n, r) => n + r.quantityMilli, 0) +
          (b.quantityMilli as number) >
          -original.quantityMilli
      )
        throw new ConflictException(
          'Devolução física maior que a saída disponível.',
        );
      if(!await tx.posProduct.findFirst({where:{id:original.lot.productId,companyId:actor.companyId,stockManaged:true}}))throw new ConflictException('Reative o controle de estoque antes da devolução física.');
      const op = await tx.posInventoryOperation.create({
        data: {
          companyId: actor.companyId,
          sourceKey: key,
          requestHash,
          type: 'RETURN',
          actorId: actor.userId,
          reason,
        },
      });
      await tx.posInventoryLot.update({
        where: { id: original.lotId },
        data: { quantityMilli: { increment: b.quantityMilli as number } },
      });
      await tx.posProduct.update({
        where: { id: original.lot.productId },
        data: { stockMilli: { increment: b.quantityMilli as number } },
      });
      await tx.posInventoryMovement.create({
        data: {
          companyId: actor.companyId,
          operationId: op.id,
          lotId: original.lotId,
          restoreOfId: original.id,
          lineId: original.lineId,
          quantityMilli: b.quantityMilli as number,
          costMilliCents:
            BigInt(b.quantityMilli as number) *
            BigInt(original.lot.unitCostCents),
        },
      });
      await this.ops.notify(tx, actor.companyId);
      return { id: op.id };
    });
  }
  async dashboard(actor: Operator) {
    if (!readers.includes(actor.role)) throw new ForbiddenException();
    const sub = await this.entitlements.current(actor.companyId);
    return this.db.$transaction(
      async (tx) => {
        const products = await tx.posProduct.findMany({
            where: {
              companyId: actor.companyId,
              giftCard: { is: null },
              packageDefinition: { is: null },
            },
            include: { category: true },
            orderBy: { name: 'asc' },
            take: 500,
          }),
          lots = await tx.posInventoryLot.findMany({
            where: { companyId: actor.companyId, quantityMilli: { gt: 0 } },
            include: {
              product: { select: { name: true, unit: true } },
              supplier: { select: { name: true } },
            },
            orderBy: [
              { expiresAt: { sort: 'asc', nulls: 'last' } },
              { createdAt: 'asc' },
            ],
            take: 500,
          }),
          movements = await tx.posInventoryMovement.findMany({
            where: { companyId: actor.companyId },
            include: {
              operation: {
                select: { type: true, reason: true, createdAt: true },
              },
              lot: {
                select: {
                  productId: true,
                  product: { select: { name: true, unit: true } },
                  code: true,
                },
              },
              returns: { select: { quantityMilli: true } },
            },
            orderBy: { createdAt: 'desc' },
            take: 200,
          });
        const [summary] = await tx.$queryRaw<
          Array<{
            totalProducts: number;
            stockMilli: string;
            costMilliCents: string;
            low: number;
            expiring: number;
          }>
        >`SELECT (SELECT count(*)::int FROM "PosProduct" WHERE "companyId"=${actor.companyId}::uuid AND "stockManaged") AS "totalProducts",COALESCE(sum("quantityMilli"),0)::text AS "stockMilli",COALESCE(sum("quantityMilli"::bigint*"unitCostCents"),0)::text AS "costMilliCents",(SELECT count(*)::int FROM "PosProduct" WHERE "companyId"=${actor.companyId}::uuid AND "stockManaged" AND COALESCE((SELECT sum(l."quantityMilli") FROM "PosInventoryLot" l WHERE l."productId"="PosProduct".id AND l."companyId"="PosProduct"."companyId" AND (l."expiresAt" IS NULL OR l."expiresAt">CURRENT_TIMESTAMP)),0)<="minimumMilli") AS low,count(*) FILTER(WHERE "quantityMilli">0 AND "expiresAt"<=CURRENT_TIMESTAMP+INTERVAL '30 days')::int AS expiring FROM "PosInventoryLot" WHERE "companyId"=${actor.companyId}::uuid`;
        const valid = await tx.$queryRaw<
          Array<{ productId: string; validMilli: string }>
        >`SELECT "productId",COALESCE(sum("quantityMilli") FILTER(WHERE "expiresAt" IS NULL OR "expiresAt">CURRENT_TIMESTAMP),0)::text AS "validMilli" FROM "PosInventoryLot" WHERE "companyId"=${actor.companyId}::uuid GROUP BY "productId"`;
        const serviceCosts = await tx.$queryRaw<
          Array<{ serviceId: string; name: string; costMilliCents: string }>
        >`SELECT l."serviceId",s.name,(-sum(m."costMilliCents"))::text AS "costMilliCents" FROM "PosInventoryMovement" m JOIN "PosSaleLine" l ON l.id=m."lineId" AND l."companyId"=m."companyId" JOIN "Service" s ON s.id=l."serviceId" AND s."companyId"=m."companyId" WHERE m."companyId"=${actor.companyId}::uuid GROUP BY l."serviceId",s.name ORDER BY sum(m."costMilliCents") LIMIT 100`;
        const topSold = await tx.$queryRaw<
          Array<{
            productId: string;
            name: string;
            unit: string;
            quantityMilli: string;
          }>
        >`SELECT l."productId",p.name,p.unit,(-sum(m."quantityMilli"))::text AS "quantityMilli" FROM "PosInventoryMovement" m JOIN "PosSaleLine" l ON l.id=m."lineId" AND l."companyId"=m."companyId" JOIN "PosProduct" p ON p.id=l."productId" AND p."companyId"=m."companyId" WHERE m."companyId"=${actor.companyId}::uuid GROUP BY l."productId",p.name,p.unit ORDER BY sum(m."quantityMilli") LIMIT 20`;
        const dormant = await tx.$queryRaw<
          Array<{ id: string; name: string; unit: string; stockMilli: number }>
        >`SELECT p.id,p.name,p.unit,p."stockMilli" FROM "PosProduct" p WHERE p."companyId"=${actor.companyId}::uuid AND p."stockManaged" AND p."stockMilli">0 AND NOT EXISTS(SELECT 1 FROM "PosInventoryMovement" m JOIN "PosInventoryLot" lot ON lot.id=m."lotId" AND lot."companyId"=m."companyId" WHERE lot."productId"=p.id AND m."companyId"=p."companyId" AND m."quantityMilli"<0 AND m."lineId" IS NOT NULL AND m."createdAt">CURRENT_TIMESTAMP-INTERVAL '30 days') ORDER BY p.name LIMIT 100`;
        const recipes = await tx.posServiceMaterial.findMany({
          where: { companyId: actor.companyId },
          include: {
            service: { select: { name: true } },
            product: { select: { name: true, unit: true } },
          },
          take: 1000,
        });
        return {
          timezone:(await tx.company.findUniqueOrThrow({where:{id:actor.companyId},select:{timezone:true}})).timezone,
          entitled: sub.plan.features.some(
            (f) => f.code === 'inventory' && f.enabled,
          ),
          policy: 'SALE_FINALIZED_FEFO_NO_NEGATIVE',
          summary,
          products: products.map((p) => ({
            ...p,
            validMilli: Number(
              valid.find((v) => v.productId === p.id)?.validMilli ?? 0,
            ),
          })),
          lots,
          serviceCosts,
          topSold,
          dormant,
          movements: movements.map((m) => ({
            ...m,
            costMilliCents: m.costMilliCents.toString(),
            restorableMilli:
              m.quantityMilli < 0
                ? -m.quantityMilli -
                  m.returns.reduce((n, r) => n + r.quantityMilli, 0)
                : 0,
          })),
          recipes,
          categories: await tx.posInventoryCategory.findMany({
            where: { companyId: actor.companyId },
          }),
          suppliers: await tx.posInventorySupplier.findMany({
            where: { companyId: actor.companyId },
          }),
          services: await tx.service.findMany({
            where: { companyId: actor.companyId },
            select: { id: true, name: true },
          }),
          truncated:
            products.length === 500 ||
            lots.length === 500 ||
            movements.length === 200 ||
            recipes.length === 1000,
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
}
