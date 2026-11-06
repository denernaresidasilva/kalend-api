import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Operator, Sale } from './operations.service.js';
import { allocateNet, netReceived } from './pos-domain.js';
import { weightedCents } from './package-funding.js';
import { reconcileCommissions } from './commission-domain.js';
import { reverseLoyalty } from './loyalty-domain.js';
import { queueCustomerEvent } from './operational-messages.js';
export async function assertPackageSaleable(
  tx: Prisma.TransactionClient,
  companyId: string,
  productId: string,
) {
  const definition = await tx.posPackageDefinition.findFirst({
    where: { companyId, productId, active: true, product: { active: true } },
    include: { services: { include: { professionals: true, service: true } } },
  });
  if (!definition || !definition.services.length)
    throw new ConflictException('Pacote não disponível para nova venda.');
  for (const item of definition.services) {
    if (
      !item.service.active ||
      !(await tx.professionalProfile.findFirst({
        where: {
          companyId,
          active: true,
          membership: {
            isActive: true,
            role: { in: ['OWNER', 'ADMIN', 'PROFESSIONAL'] },
          },
          services: { some: { serviceId: item.serviceId } },
          ...(item.professionals.length
            ? { id: { in: item.professionals.map((p) => p.professionalId) } }
            : {}),
        },
        select: { id: true },
      }))
    )
      throw new ConflictException(
        'Um serviço ou profissional do pacote não está disponível.',
      );
  }
  return definition;
}
export async function grantPackages(
  tx: Prisma.TransactionClient,
  actor: Operator,
  sale: Sale,
) {
  const active = sale.lines.filter((l) => !l.voidedAt),
    allocation = allocateNet(
      active.map((l) => ({ id: l.id, gross: l.unitPriceCents * l.quantity })),
      sale.discountCents,
    );
  for (const line of active) {
    if (!line.productId) continue;
    const definition = await tx.posPackageDefinition.findFirst({
      where: { companyId: sale.companyId, productId: line.productId },
      include: {
        services: { include: { professionals: true }, orderBy: { id: 'asc' } },
      },
    });
    if (!definition) continue;
    if (
      !sale.customerId ||
      line.quantity !== 1 ||
      netReceived(sale.payments, sale.refunds) !== sale.totalCents
    )
      throw new ConflictException(
        'Pacote exige cliente identificado e pagamento integral.',
      );
    const amount = allocation.get(line.id) ?? 0;
    if (amount <= 0)
      throw new ConflictException(
        'Pacote exige valor líquido positivo confirmado.',
      );
    if (
      await tx.posPackageWallet.findUnique({
        where: {
          sourceLineId_companyId: {
            sourceLineId: line.id,
            companyId: sale.companyId,
          },
        },
      })
    )
      continue;
    const units = definition.services.flatMap((s) =>
        Array.from({ length: s.sessions }, () => ({
          serviceId: s.serviceId,
          weight: s.listPriceCents,
          eligibleProfessionalIds: s.professionals.map((p) => p.professionalId),
        })),
      ),
      values = weightedCents(
        amount,
        units.map((u) => u.weight),
      );
    if (!units.length || units.length > 100)
      throw new ConflictException('Definição do pacote sem sessões válidas.');
    const wallet = await tx.posPackageWallet.create({
      data: {
        companyId: sale.companyId,
        customerId: sale.customerId,
        definitionId: definition.id,
        sourceLineId: line.id,
        sourceSaleId: sale.id,
        originalCents: amount,
        expiresAt: new Date(Date.now() + definition.validityDays * 86400000),
      },
    });
    await tx.posPackageSession.createMany({
      data: units.map((u, i) => ({
        companyId: sale.companyId,
        walletId: wallet.id,
        serviceId: u.serviceId,
        ordinal: i + 1,
        valueCents: values[i],
        eligibleProfessionalIds: u.eligibleProfessionalIds,
      })),
    });
    await tx.posPackageMovement.create({
      data: {
        companyId: sale.companyId,
        walletId: wallet.id,
        type: 'GRANT',
        sourceKey: 'GRANT:' + line.id,
        units: units.length,
        actorId: actor.userId,
        reason: 'Pacote pago na comanda ' + sale.id,
      },
    });
    await queueCustomerEvent(
      tx,
      sale.companyId,
      sale.customerId,
      'OP_PACKAGE_CREDITED',
      wallet.id,
      {
        __saleId: sale.id,
        __walletId: wallet.id,
        servico: definition.name,
        valor: new Intl.NumberFormat('pt-BR', {
          style: 'currency',
          currency: 'BRL',
        }).format(amount / 100),
      },
    );
  }
}
export async function consumePackages(
  tx: Prisma.TransactionClient,
  actor: Operator,
  sale: Sale,
) {
  const uses = await tx.posPackageUse.findMany({
    where: { companyId: sale.companyId, saleId: sale.id, status: 'RESERVED' },
    include: { session: { include: { wallet: true } }, line: true },
  });
  for (const use of uses) {
    const wallet = use.session.wallet;
    if (
      use.line.voidedAt ||
      !use.line.completedAt ||
      wallet.status !== 'ACTIVE' ||
      wallet.expiresAt < use.line.completedAt ||
      wallet.customerId !== sale.customerId ||
      use.session.state !== 'RESERVED'
    )
      throw new ConflictException(
        'Sessão de pacote expirada, suspensa ou sem atendimento concluído.',
      );
    const source = await tx.posSale.findUniqueOrThrow({
      where: { id: wallet.sourceSaleId },
      include: { payments: true, refunds: true },
    });
    if (
      source.status !== 'PAID' ||
      netReceived(source.payments, source.refunds) !== source.totalCents
    )
      throw new ConflictException(
        'O pagamento de origem do pacote não está válido.',
      );
    await tx.posPackageUse.update({
      where: { id: use.id },
      data: { status: 'CONSUMED', consumedAt: new Date() },
    });
    await tx.posPackageSession.update({
      where: { id: use.sessionId },
      data: { state: 'CONSUMED' },
    });
    await tx.posPackageMovement.create({
      data: {
        companyId: sale.companyId,
        walletId: wallet.id,
        useId: use.id,
        type: 'CONSUME',
        sourceKey: 'CONSUME:' + use.id,
        units: -1,
        actorId: actor.userId,
        reason: 'Sessão concluída na comanda ' + sale.id,
      },
    });
    await queueCustomerEvent(
      tx,
      sale.companyId,
      wallet.customerId,
      'OP_PACKAGE_USED',
      use.id,
      { __saleId: sale.id, __packageUseId: use.id, servico: use.line.name },
    );
  }
}
export async function releasePackageUses(
  tx: Prisma.TransactionClient,
  actor: Operator,
  saleId: string,
  reason: string,
  lineId?: string,
  restorePrice = false,
) {
  const uses = await tx.posPackageUse.findMany({
    where: {
      companyId: actor.companyId,
      saleId,
      status: 'RESERVED',
      ...(lineId ? { lineId } : {}),
    },
    include: { session: true },
  });
  for (const use of uses) {
    await tx.posPackageUse.update({
      where: { id: use.id },
      data: { status: 'RELEASED' },
    });
    await tx.posPackageSession.update({
      where: { id: use.sessionId },
      data: { state: 'AVAILABLE' },
    });
    if (restorePrice)
      await tx.posSaleLine.update({
        where: { id: use.lineId },
        data: { unitPriceCents: use.originalUnitPriceCents },
      });
    await tx.posPackageMovement.create({
      data: {
        companyId: actor.companyId,
        walletId: use.session.walletId,
        useId: use.id,
        type: 'RELEASE',
        sourceKey: 'RELEASE:' + use.id,
        units: 0,
        actorId: actor.userId,
        reason,
      },
    });
  }
}
export async function suspendRefundedPackages(
  tx: Prisma.TransactionClient,
  actor: Operator,
  sourceSale: Sale,
  refundId: string,
) {
  const professionalIds = new Set<string>();
  const wallets = await tx.posPackageWallet.findMany({
    where: { companyId: actor.companyId, sourceSaleId: sourceSale.id },
  });
  for (const wallet of wallets) {
    await tx.posPackageWallet.update({
      where: { id: wallet.id },
      data: { status: 'SUSPENDED' },
    });
    await tx.posPackageMovement.create({
      data: {
        companyId: actor.companyId,
        walletId: wallet.id,
        type: 'REFUND_SUSPEND',
        sourceKey: 'REFUND:' + refundId + ':' + wallet.id,
        units: 0,
        actorId: actor.userId,
        reason:
          'Pagamento de origem estornado; saldo preservado e uso suspenso para revisão.',
      },
    });
    const affected = await tx.posPackageUse.findMany({
      where: {
        companyId: actor.companyId,
        session: { walletId: wallet.id },
        status: 'CONSUMED',
      },
      select: { saleId: true, line: { select: { professionalId: true } } },
    });
    for (const use of affected)
      if (use.line.professionalId) professionalIds.add(use.line.professionalId);
    for (const saleId of new Set(affected.map((a) => a.saleId))) {
      const sale = await tx.posSale.findUniqueOrThrow({
        where: { id: saleId },
        include: { payments: true, refunds: true },
      });
      await reconcileCommissions(tx, actor, sale, 'PACKAGE_REFUND:' + refundId);
      await reverseLoyalty(tx, sale, 'PACKAGE_REFUND:' + refundId);
    }
  }
  return [...professionalIds];
}
