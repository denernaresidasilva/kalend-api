import {creditGiftCard,assertGiftSource,assertGiftSourceRefund,refundGiftCard} from './gift-card-domain.js';
import { clientBenefits } from './client-subscription-domain.js';
import { proportionFloor } from './pos-domain.js';
import { grantPackages,consumePackages,releasePackageUses,suspendRefundedPackages,assertPackageSaleable } from './package-domain.js';
import { attendanceEvent } from '../bookings/attendance-domain.js';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type PosPaymentMethod } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { EntitlementsService } from '../billing/entitlements.service.js';
import { withBillingConflictRetry } from '../billing/transaction-conflict.js';
import { integer, object, string, uuid } from '../common/validation.js';
import { confirmLoyalty, reverseLoyalty } from './loyalty-domain.js';
import { saleEvent, scheduleFollowups } from './operational-messages.js';
import { cashBalance, generateCommissions, reconcileCommissions } from './commission-domain.js';
import { netReceived, terminalSale, totalSale } from './pos-domain.js';
export type Operator = { companyId: string; userId: string; membershipId: string; role: string };
type Tx = Prisma.TransactionClient;
const managers = ['OWNER', 'ADMIN'];
const cashiers = [...managers, 'RECEPTIONIST'];
const workers = [...cashiers, 'PROFESSIONAL'];
const baseSaleInclude = { customer: { select: { id: true, name: true } }, lines: { include: { professional: { select: { id: true, membershipId: true, displayName: true } } }, orderBy: { createdAt: 'asc' as const } }, payments: { orderBy: { createdAt: 'asc' as const } }, refunds: { orderBy: { createdAt: 'asc' as const } } } as const;
const saleInclude = { issuedGiftCard:{select:{id:true,faceCents:true}}, customer: { select: { id: true, name: true } }, lines: { include: { packageUses:{where:{status:{in:['RESERVED','CONSUMED'] as string[]}},select:{id:true,sessionId:true,status:true,allocatedCents:true,originalUnitPriceCents:true,session:{select:{wallet:{select:{id:true,definition:{select:{name:true}}}}}}}}, professional: { select: { id: true, membershipId: true, displayName: true } } }, orderBy: { createdAt: 'asc' as const } }, payments: { orderBy: { createdAt: 'asc' as const } }, refunds: { orderBy: { createdAt: 'asc' as const } } } as const;
export type Sale = Prisma.PosSaleGetPayload<{ include: typeof baseSaleInclude }> & {issuedGiftCard?:{id:string;faceCents:number}|null};
@Injectable()
export class OperationsService {
  constructor(@Inject(PrismaService) private readonly db: PrismaService, @Inject(EntitlementsService) private readonly entitlements: EntitlementsService) {}
  private role(actor: Operator, allowed: string[]) { if (!allowed.includes(actor.role)) throw new ForbiddenException('Operação não autorizada para seu papel.'); }
  async change<T>(actor: Operator, allowed: string[], work: (tx: Tx) => Promise<T>) {
    this.role(actor, allowed);
    return withBillingConflictRetry(() => this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${actor.companyId}:operations`}, 0))::text`;
      const member = await tx.membership.findFirst({ where: { id: actor.membershipId, companyId: actor.companyId, userId: actor.userId, role: actor.role as never, isActive: true, company: { isActive: true, administrativeStatus: 'ACTIVE' } } });
      if (!member) throw new ForbiddenException('Vínculo da operação não está mais ativo.');
      await this.entitlements.current(actor.companyId, tx);
      return work(tx);
    }, { isolationLevel: 'Serializable', maxWait: 5000, timeout: 10000 }));
  }
  async sale(tx: Tx, actor: Operator, id: string) {
    const sale = await tx.posSale.findFirst({ where: { id, companyId: actor.companyId }, include: saleInclude });
    if (!sale) throw new NotFoundException('Comanda não encontrada.');
    return sale;
  }
  assertEditable(sale: Sale) { if(sale.issuedGiftCard)throw new ConflictException('Cartão-presente usa comanda exclusiva sem alteração de itens ou descontos. Cancele e crie outra venda se necessário.'); if (terminalSale(sale.status) || sale.payments.length) throw new ConflictException('A comanda já possui recebimento ou está encerrada.'); }
  private async audit(tx: Tx, actor: Operator, action: string, detail: Prisma.InputJsonObject, saleId?: string) { await tx.posAudit.create({ data: { companyId: actor.companyId, actorId: actor.userId, saleId, action, detail } }); }
  async notify(tx: Tx, companyId: string, professionalIds: string[] = []) {
    const ids = [...new Set(professionalIds)];
    for (let i = 0; i < Math.max(1, ids.length); i += 8) await tx.$queryRaw`SELECT pg_notify('kalend_booking_events', ${JSON.stringify({ companyId, professionalIds: ids.slice(i, i + 8) })})::text`;
  }
  async recalculate(tx: Tx, sale: Sale) {
    const totals = totalSale(sale.lines, sale.discountCents);
    return tx.posSale.update({ where: { id: sale.id }, data: totals });
  }
  private async openCash(tx: Tx, companyId: string) { const cash = await tx.posCashSession.findFirst({ where: { companyId, closedAt: null } }); if (!cash) throw new ConflictException('Abra o caixa antes de registrar recebimentos ou estornos.'); return cash; }
  async board(actor: Operator) {
    this.role(actor, workers);
    const sales = await this.db.posSale.findMany({ where: { companyId: actor.companyId, ...(actor.role === 'PROFESSIONAL' ? { lines: { some: { professional: { membershipId: actor.membershipId } } } } : {}) }, include: saleInclude, orderBy: [{ status: 'asc' }, { createdAt: 'desc' }], take: 100 });
    if (actor.role === 'PROFESSIONAL') return { cash: null, sales: sales.map(s => ({ id: s.id, status: s.status, customer: s.customer ? { name: s.customer.name } : null, lines: s.lines.filter(l => l.professional?.membershipId === actor.membershipId).map(l => ({ id: l.id, name: l.name, quantity: l.quantity, startedAt: l.startedAt, completedAt: l.completedAt, voidedAt: l.voidedAt, serviceId: l.serviceId })) })) };
    const cash = await this.db.posCashSession.findFirst({ where: { companyId: actor.companyId, closedAt: null } });
    const closed = await this.db.posCashSession.findMany({ where: { companyId: actor.companyId, closedAt: { not: null } }, orderBy: { closedAt: 'desc' }, take: 20 });
    return { cash, closed, sales: sales.map(s => ({ ...s, receivedCents: netReceived(s.payments, s.refunds) })) };
  }
  async catalog(actor: Operator) {
    this.role(actor, cashiers);
    const [products, services, professionals, coupons] = await Promise.all([
      this.db.posProduct.findMany({ where: { companyId: actor.companyId,giftCard:{is:null} }, orderBy: { name: 'asc' } }),
      this.db.service.findMany({ where: { companyId: actor.companyId, active: true }, select: { id: true, name: true, priceCents: true } }),
      this.db.professionalProfile.findMany({ where: { companyId: actor.companyId, active: true, membership: { isActive: true, role: { in: ['OWNER', 'ADMIN', 'PROFESSIONAL'] } } }, select: { id: true, displayName: true, services: { select: { serviceId: true } } } }),
      this.db.posCoupon.findMany({ where: { companyId: actor.companyId }, orderBy: { createdAt: 'desc' } }),
    ]); return { products, services, professionals, coupons };
  }
  async createProduct(actor: Operator, input: unknown) {
    const body = object(input, ['name', 'priceCents']); integer(body.priceCents, 'priceCents', 0, 100_000_000);
    return this.change(actor, managers, async tx => { const row = await tx.posProduct.create({ data: { companyId: actor.companyId, name: string(body.name, 'name', 120), priceCents: body.priceCents as number } }); await this.audit(tx, actor, 'PRODUCT_CREATED', { productId: row.id }); return row; });
  }
  async createCoupon(actor: Operator, input: unknown) {
    const body = object(input, ['code', 'percentBps', 'fixedCents', 'minSubtotalCents', 'maxUses', 'expiresAt']);
    const code = string(body.code, 'code', 40).toUpperCase(); if (!/^[A-Z0-9_-]{3,40}$/.test(code)) throw new BadRequestException('Código de cupom inválido.');
    if ((body.percentBps !== undefined) === (body.fixedCents !== undefined)) throw new BadRequestException('Escolha percentual ou valor fixo.');
    if (body.percentBps !== undefined) integer(body.percentBps, 'percentBps', 1, 10000);
    if (body.fixedCents !== undefined) integer(body.fixedCents, 'fixedCents', 1, 100_000_000);
    integer(body.minSubtotalCents ?? 0, 'minSubtotalCents', 0, 100_000_000);
    if (body.maxUses !== undefined) integer(body.maxUses, 'maxUses', 1, 1_000_000);
    const expiresAt = body.expiresAt === undefined ? null : new Date(string(body.expiresAt, 'expiresAt', 40));
    if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date())) throw new BadRequestException('Validade do cupom inválida.');
    return this.change(actor, managers, async tx => { const row = await tx.posCoupon.create({ data: { companyId: actor.companyId, code, percentBps: body.percentBps as number | undefined, fixedCents: body.fixedCents as number | undefined, minSubtotalCents: body.minSubtotalCents as number | undefined, maxUses: body.maxUses as number | undefined, expiresAt } }); await this.audit(tx, actor, 'COUPON_CREATED', { couponId: row.id }); return row; });
  }
  async cashOpen(actor: Operator, input: unknown) {
    const body = object(input, ['openingCents']); integer(body.openingCents, 'openingCents', 0, 100_000_000);
    return this.change(actor, cashiers, async tx => {
      if (await tx.posCashSession.findFirst({ where: { companyId: actor.companyId, closedAt: null } })) throw new ConflictException('Já existe um caixa aberto.');
      const cash = await tx.posCashSession.create({ data: { companyId: actor.companyId, openingCents: body.openingCents as number, openedById: actor.userId } });
      await this.audit(tx, actor, 'CASH_OPENED', { cashSessionId: cash.id, openingCents: cash.openingCents }); return cash;
    });
  }
  async cashClose(actor: Operator, id: string, input: unknown) {
    const body = object(input, ['countedCents', 'note']); integer(body.countedCents, 'countedCents', 0, 1_000_000_000);
    return this.change(actor, cashiers, async tx => {
      const cash = await tx.posCashSession.findFirst({ where: { id, companyId: actor.companyId } }); if (!cash) throw new NotFoundException('Caixa não encontrado.');
      if (cash.closedAt) throw new ConflictException('O caixa já foi fechado.');
      const expectedCents = await cashBalance(tx, actor.companyId, cash);
      const differenceCents = (body.countedCents as number) - expectedCents;
      const note = body.note === undefined || body.note === '' ? null : string(body.note, 'note', 1000);
      if (differenceCents !== 0 && !note) throw new BadRequestException('Justifique a diferença de caixa.');
      const result = await tx.posCashSession.update({ where: { id }, data: { expectedCents, countedCents: body.countedCents as number, differenceCents, closedAt: new Date(), closedById: actor.userId, closingNote: note } });
      await this.audit(tx, actor, 'CASH_CLOSED', { cashSessionId: id, expectedCents, differenceCents }); return result;
    });
  }
  async openSale(actor: Operator, input: unknown) {
    const body = object(input, ['bookingRequestId', 'customerId', 'idempotencyKey']); const key = uuid(body.idempotencyKey);
    const bookingRequestId = body.bookingRequestId === undefined ? null : uuid(body.bookingRequestId);
    const customerId = body.customerId === undefined ? null : uuid(body.customerId);
    const requestHash = createHash('sha256').update(JSON.stringify({ bookingRequestId, customerId })).digest('hex');
    return this.change(actor, cashiers, async tx => {
      const old = await tx.posSale.findUnique({ where: { companyId_idempotencyKey: { companyId: actor.companyId, idempotencyKey: key } } });
      if (old) { if (old.requestHash !== requestHash) throw new ConflictException('Chave já usada para outra comanda.'); return this.sale(tx, actor, old.id); }
      const booking = bookingRequestId ? await tx.bookingRequest.findFirst({ where: { id: bookingRequestId, companyId: actor.companyId, status: 'CONFIRMED' }, include: { items: true } }) : null;
      if (bookingRequestId && !booking) throw new ConflictException('Agendamento confirmado não encontrado nesta empresa.');
      if (bookingRequestId) { const same = await tx.posSale.findFirst({ where: { companyId: actor.companyId, bookingRequestId } }); if (same) return this.sale(tx, actor, same.id); }
      if (customerId && !await tx.customerProfile.findFirst({ where: { id: customerId, companyId: actor.companyId } })) throw new NotFoundException('Cliente não encontrado.');
      const sale = await tx.posSale.create({ data: { companyId: actor.companyId, bookingRequestId, customerId: booking?.customerId ?? customerId, idempotencyKey: key, requestHash, openedById: actor.userId } });
      if (booking) await tx.posSaleLine.createMany({ data: booking.items.map(item => ({ companyId: actor.companyId, saleId: sale.id, bookingItemId: item.id, serviceId: item.serviceId, professionalId: item.professionalId, name: item.serviceName, unitPriceCents: item.priceCents,subscriptionDiscountCents:item.subscriptionDiscountCents,clientSubscriptionId:item.clientSubscriptionId, quantity: 1 })) });
      await this.recalculate(tx, await this.sale(tx, actor, sale.id)); await this.audit(tx, actor, 'SALE_OPENED', { bookingRequestId }, sale.id); await this.notify(tx, actor.companyId, booking?.items.map(i => i.professionalId)); return this.sale(tx, actor, sale.id);
    });
  }
  async addLine(actor: Operator, id: string, input: unknown) {
    const body = object(input, ['serviceId', 'productId', 'professionalId', 'quantity']); integer(body.quantity ?? 1, 'quantity', 1, 100);
    if ((body.serviceId !== undefined) === (body.productId !== undefined)) throw new BadRequestException('Escolha um serviço ou produto.');
    return this.change(actor, cashiers, async tx => {
      const sale = await this.sale(tx, actor, id); this.assertEditable(sale); if (sale.lines.length >= 100) throw new BadRequestException('Limite de itens atingido.');
      let name: string, unitPriceCents: number; let serviceId: string | undefined, productId: string | undefined, professionalId: string | undefined;
      if (body.serviceId) {
        serviceId = uuid(body.serviceId); professionalId = uuid(body.professionalId);
        const service = await tx.service.findFirst({ where: { id: serviceId, companyId: actor.companyId, active: true, professionalLinks: { some: { professionalId, professional: { active: true, membership: { isActive: true, role: { in: ['OWNER', 'ADMIN', 'PROFESSIONAL'] } } } } } } });
        if (!service) throw new BadRequestException('Serviço ou profissional indisponível nesta empresa.'); name = service.name; unitPriceCents = service.priceCents;
      } else {
        productId = uuid(body.productId); const product = await tx.posProduct.findFirst({ where: { id: productId, companyId: actor.companyId, active: true } }); if (!product) throw new BadRequestException('Produto indisponível nesta empresa.');const packageDefinition=await tx.posPackageDefinition.findUnique({where:{productId:product.id}});if(packageDefinition){await this.entitlements.assertFeature(actor.companyId,'packages',tx);await assertPackageSaleable(tx,actor.companyId,product.id);if((body.quantity??1)!==1||!sale.customerId)throw new ConflictException('Venda um pacote por item e identifique o cliente na comanda.');if(await tx.posSaleLine.count({where:{companyId:actor.companyId,saleId:id,product:{packageDefinition:{isNot:null}}}})>=10)throw new ConflictException('Limite de dez pacotes por comanda.');} name = product.name; unitPriceCents = product.priceCents;
      }
      const benefit=serviceId?await clientBenefits(tx,actor.companyId,sale.customerId):null,subscriptionDiscountCents=benefit?proportionFloor(unitPriceCents,benefit.discountBps,10000):0;unitPriceCents-=subscriptionDiscountCents;
      await tx.posSaleLine.create({ data: { companyId: actor.companyId, saleId: id,subscriptionDiscountCents,clientSubscriptionId:benefit?.discountSubscriptionId??null, serviceId, productId, professionalId, name, unitPriceCents, quantity: (body.quantity ?? 1) as number } });
      await this.recalculate(tx, await this.sale(tx, actor, id)); const fresh = await this.sale(tx, actor, id); await tx.posSale.update({ where: { id }, data: { status: fresh.lines.some(l => l.startedAt) ? 'IN_PROGRESS' : 'OPEN' } }); await this.audit(tx, actor, 'LINE_ADDED', { serviceId: serviceId ?? null, productId: productId ?? null, quantity: (body.quantity ?? 1) as number }, id); await this.notify(tx, actor.companyId, professionalId ? [professionalId] : []); return this.sale(tx, actor, id);
    });
  }
  async lineAction(actor: Operator, lineId: string, action: 'start' | 'complete' | 'void', input: unknown = {}) {
    const body = object(input, action === 'void' ? ['reason'] : []);
    return this.change(actor, action === 'void' ? cashiers : workers, async tx => {
      const line = await tx.posSaleLine.findFirst({ where: { id: lineId, companyId: actor.companyId }, include: { professional: true } }); if (!line) throw new NotFoundException('Item não encontrado.');
      const sale = await this.sale(tx, actor, line.saleId); if (terminalSale(sale.status)) throw new ConflictException('Comanda encerrada.');
      if (actor.role === 'PROFESSIONAL' && line.professional?.membershipId !== actor.membershipId) throw new ForbiddenException('Este atendimento pertence a outro profissional.');
      if (line.voidedAt) throw new ConflictException('Item cancelado.');
      if (action === 'void') {
        this.assertEditable(sale); if (line.startedAt) throw new ConflictException('Atendimento já iniciado.');
        await releasePackageUses(tx,actor,sale.id,string(body.reason,'reason',1000),lineId);
        await tx.posSaleLine.update({ where: { id: lineId }, data: { voidedAt: new Date() } }); await this.recalculate(tx, await this.sale(tx, actor, sale.id));
      } else {
        if (action === 'start' && (!line.professional?.active || !await tx.membership.findFirst({ where: { id: line.professional.membershipId, companyId: actor.companyId, isActive: true, role: { in: ['OWNER', 'ADMIN', 'PROFESSIONAL'] } } }))) throw new ConflictException('Profissional indisponível.');
        if (!line.serviceId) throw new BadRequestException('Somente serviços possuem atendimento.');
        if (action === 'start' && !line.startedAt) await tx.posSaleLine.update({ where: { id: lineId }, data: { startedAt: new Date() } });
        if (action === 'complete') { if (!line.startedAt) throw new ConflictException('Inicie o atendimento antes de concluir.'); if (!line.completedAt) await tx.posSaleLine.update({ where: { id: lineId }, data: { completedAt: new Date() } }); }
      }
      const fresh = await this.sale(tx, actor, sale.id); const pending = fresh.lines.some(l => !l.voidedAt && l.serviceId && !l.completedAt);
      await tx.posSale.update({ where: { id: sale.id }, data: { status: pending ? 'IN_PROGRESS' : 'AWAITING_PAYMENT' } });
      if (action !== 'void') await saleEvent(tx, fresh, action === 'start' ? 'OP_ATTENDANCE_STARTED' : 'OP_SERVICE_COMPLETED', lineId, {__lineId:lineId,servico:line.name});
      await this.audit(tx, actor, `LINE_${action.toUpperCase()}`, { lineId, ...(action === 'void' ? { reason: string(body.reason, 'reason', 1000) } : {}) }, sale.id); await this.notify(tx, actor.companyId, fresh.lines.flatMap(l => l.professionalId ? [l.professionalId] : [])); return { id: lineId, action };
    });
  }
  async discount(actor: Operator, id: string, input: unknown) {
    const body = object(input, ['amountCents', 'reason']); integer(body.amountCents, 'amountCents', 0, 1_000_000_000); const reason = string(body.reason, 'reason', 1000);
    return this.change(actor, managers, async tx => { const sale = await this.sale(tx, actor, id); this.assertEditable(sale); const totals = totalSale(sale.lines, body.amountCents as number); await tx.posSale.update({ where: { id }, data: { ...totals, discountReason: reason, couponId: null } }); await this.audit(tx, actor, 'DISCOUNT_AUTHORIZED', { amountCents: body.amountCents as number, reason }, id); return this.sale(tx, actor, id); });
  }
  async coupon(actor: Operator, id: string, input: unknown) {
    const body = object(input, ['code']); const code = string(body.code, 'code', 40).toUpperCase();
    return this.change(actor, cashiers, async tx => {
      const sale = await this.sale(tx, actor, id); this.assertEditable(sale);
      const coupon = await tx.posCoupon.findUnique({ where: { companyId_code: { companyId: actor.companyId, code } } });
      if (!coupon || !coupon.active || (coupon.expiresAt && coupon.expiresAt <= new Date()) || sale.subtotalCents < coupon.minSubtotalCents) throw new ConflictException('Cupom indisponível para esta comanda.');
      const uses = await tx.posSale.count({ where: { companyId: actor.companyId, couponId: coupon.id, id: { not: id }, status: { not: 'CANCELLED' } } });
      if (coupon.maxUses !== null && uses >= coupon.maxUses) throw new ConflictException('Limite de uso do cupom atingido.');
      const discount = Math.min(sale.subtotalCents, coupon.fixedCents ?? Math.floor(sale.subtotalCents * coupon.percentBps! / 10000));
      await tx.posSale.update({ where: { id }, data: { ...totalSale(sale.lines, discount), couponId: coupon.id, discountReason: `Cupom ${code}` } }); await this.audit(tx, actor, 'COUPON_APPLIED', { couponId: coupon.id, discountCents: discount }, id); return this.sale(tx, actor, id);
    });
  }
  async receive(actor: Operator, id: string, input: unknown) {
    const body = object(input, ['idempotencyKey', 'amountCents', 'method', 'reference', 'confirmed']); const key = uuid(body.idempotencyKey); integer(body.amountCents, 'amountCents', 1, 1_000_000_000);
    if (!['CASH', 'PIX', 'DEBIT_CARD', 'CREDIT_CARD', 'TRANSFER', 'OTHER'].includes(String(body.method)) || body.confirmed !== true) throw new BadRequestException('Confira o recebimento e o método.');
    const reference = body.reference === undefined || body.reference === '' ? null : string(body.reference, 'reference', 160);
    if (body.method !== 'CASH' && !reference) throw new BadRequestException('Informe a referência do recebimento conferido.');
    return this.change(actor, cashiers, async tx => {
      const old = await tx.posReceipt.findUnique({ where: { companyId_idempotencyKey: { companyId: actor.companyId, idempotencyKey: key } } });
      if (old) { if (old.saleId !== id || old.amountCents !== body.amountCents || old.method !== body.method || old.reference !== reference) throw new ConflictException('Chave de recebimento já utilizada.'); return old; }
      const sale = await this.sale(tx, actor, id); if (terminalSale(sale.status)) throw new ConflictException('Comanda encerrada.');
      if (!sale.lines.some(l => !l.voidedAt) || netReceived(sale.payments, sale.refunds) + (body.amountCents as number) > sale.totalCents) throw new ConflictException('Recebimento maior que o saldo da comanda.');
      if(sale.issuedGiftCard)assertGiftSource(sale,sale.issuedGiftCard.faceCents);
      const cash = await this.openCash(tx, actor.companyId);
      const receipt = await tx.posReceipt.create({ data: { companyId: actor.companyId, saleId: id, cashSessionId: cash.id, idempotencyKey: key, amountCents: body.amountCents as number, method: body.method as PosPaymentMethod, reference, recordedById: actor.userId } });
      await saleEvent(tx, sale, 'OP_RECEIPT_RECORDED', receipt.id, {__factId:receipt.id});
      await this.audit(tx, actor, 'RECEIPT_RECORDED', { receiptId: receipt.id, amountCents: receipt.amountCents, method: receipt.method }, id); await this.notify(tx, actor.companyId); return receipt;
    });
  }
  async finalize(actor: Operator, id: string) {
    return this.change(actor, cashiers, async tx => {
      const sale = await this.sale(tx, actor, id); if (sale.status === 'PAID') return sale;
      if (terminalSale(sale.status)) throw new ConflictException('Comanda encerrada.');
      const lines = sale.lines.filter(l => !l.voidedAt);
      if (!lines.length || lines.some(l => l.serviceId && !l.completedAt)) throw new ConflictException('Conclua todos os atendimentos da comanda.');
      if (netReceived(sale.payments, sale.refunds) !== sale.totalCents) throw new ConflictException('A comanda ainda possui saldo a receber.');
      await tx.posSale.update({ where: { id }, data: { status: 'PAID', finalizedAt: new Date(), finalizedById: actor.userId } });
      if(await tx.posPackageDefinition.count({where:{companyId:actor.companyId,productId:{in:sale.lines.flatMap(l=>l.productId?[l.productId]:[])}}})||await tx.posPackageUse.count({where:{companyId:actor.companyId,saleId:sale.id,status:'RESERVED'}}))await this.entitlements.assertFeature(actor.companyId,'packages',tx);
      await grantPackages(tx,actor,sale);await consumePackages(tx,actor,sale);if(sale.issuedGiftCard){await this.entitlements.assertFeature(actor.companyId,'gift_cards',tx);await creditGiftCard(tx,actor,sale);}
      await generateCommissions(tx, actor, sale);
      await scheduleFollowups(tx, sale);
      await confirmLoyalty(tx, sale);
      if(sale.bookingRequestId)await attendanceEvent(tx,sale.companyId,sale.bookingRequestId,'COMPLETED','SALE:'+sale.id,actor.userId);
      await saleEvent(tx, sale, 'OP_SALE_PAID', sale.id);
      await this.audit(tx, actor, 'SALE_FINALIZED', { totalCents: sale.totalCents }, id); await this.notify(tx, actor.companyId, lines.flatMap(l => l.professionalId ? [l.professionalId] : [])); return this.sale(tx, actor, id);
    });
  }
  async refund(actor: Operator, receiptId: string, input: unknown) {
    const body = object(input, ['idempotencyKey', 'amountCents', 'reason', 'confirmed']); const key = uuid(body.idempotencyKey); integer(body.amountCents, 'amountCents', 1, 1_000_000_000); const reason = string(body.reason, 'reason', 1000); if (body.confirmed !== true) throw new BadRequestException('Confirme que a devolução foi conferida.');
    return this.change(actor, managers, async tx => {
      const old = await tx.posRefund.findUnique({ where: { companyId_idempotencyKey: { companyId: actor.companyId, idempotencyKey: key } } }); if (old) { if (old.receiptId !== receiptId || old.amountCents !== body.amountCents || old.reason !== reason) throw new ConflictException('Chave de estorno já utilizada.'); return old; }
      const receipt = await tx.posReceipt.findFirst({ where: { id: receiptId, companyId: actor.companyId }, include: { refunds: true } }); if (!receipt) throw new NotFoundException('Recebimento não encontrado.');
      if (receipt.refunds.reduce((n, r) => n + r.amountCents, 0) + (body.amountCents as number) > receipt.amountCents) throw new ConflictException('Estorno maior que o valor recebido.');
      await assertGiftSourceRefund(tx,actor.companyId,receipt.saleId,body.amountCents as number);
      const cash = await this.openCash(tx, actor.companyId);
      if (receipt.method === 'CASH') {
        if (await cashBalance(tx, actor.companyId, cash) < (body.amountCents as number)) throw new ConflictException('Saldo em dinheiro insuficiente neste caixa.');
      }
      const refund = await tx.posRefund.create({ data: { companyId: actor.companyId, saleId: receipt.saleId, receiptId, cashSessionId: cash.id, idempotencyKey: key, amountCents: body.amountCents as number, reason, recordedById: actor.userId } });
      await refundGiftCard(tx,actor,receipt,refund);
      const sale = await this.sale(tx, actor, receipt.saleId);
      if (['PAID', 'PARTIALLY_REFUNDED'].includes(sale.status)) await tx.posSale.update({ where: { id: sale.id }, data: { status: netReceived(sale.payments, sale.refunds) === 0 ? 'REFUNDED' : 'PARTIALLY_REFUNDED' } });
      const packageProfessionalIds=await suspendRefundedPackages(tx,actor,sale,refund.id);
      await reconcileCommissions(tx, actor, sale, refund.id);
      await reverseLoyalty(tx, sale, refund.id);
      await tx.posFollowupJob.updateMany({where:{companyId:actor.companyId,saleId:sale.id,status:'PENDING'},data:{status:'CANCELLED',result:'SALE_REFUNDED'}});
      await saleEvent(tx, sale, 'OP_REFUND_RECORDED', refund.id, {__factId:refund.id});
      await this.audit(tx, actor, 'REFUND_RECORDED', { refundId: refund.id, receiptId, amountCents: refund.amountCents, reason }, receipt.saleId); await this.notify(tx, actor.companyId, [...sale.lines.flatMap(l => l.professionalId ? [l.professionalId] : []),...packageProfessionalIds]); return refund;
    });
  }
  async cancel(actor: Operator, id: string, input: unknown) {
    const body = object(input, ['reason']); const reason = string(body.reason, 'reason', 1000);
    return this.change(actor, cashiers, async tx => { const sale = await this.sale(tx, actor, id); if (sale.status === 'CANCELLED') return sale; if (terminalSale(sale.status) || netReceived(sale.payments, sale.refunds) !== 0) throw new ConflictException('Estorne os recebimentos antes de cancelar uma comanda ainda não finalizada.'); await releasePackageUses(tx,actor,id,reason);await tx.posGiftCard.updateMany({where:{companyId:actor.companyId,sourceSaleId:id,status:'PENDING'},data:{status:'CANCELLED'}});await tx.posSale.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: actor.userId, cancellationReason: reason } }); await tx.posFollowupJob.updateMany({where:{companyId:actor.companyId,saleId:id,status:'PENDING'},data:{status:'CANCELLED',result:'SALE_CANCELLED'}});await saleEvent(tx,sale,'OP_SALE_CANCELLED',id);await this.audit(tx, actor, 'SALE_CANCELLED', { reason }, id); await this.notify(tx, actor.companyId, sale.lines.flatMap(l => l.professionalId ? [l.professionalId] : [])); return this.sale(tx, actor, id); });
  }
}
