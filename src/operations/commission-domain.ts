import { packageFunding,type CashSale } from './package-funding.js';
import type { Prisma } from '@prisma/client';
import { allocateNet, proportionFloor, netReceived } from './pos-domain.js';
import type { Operator, Sale } from './operations.service.js';
export async function cashBalance(tx: Prisma.TransactionClient, companyId: string, cash: { id: string; openingCents: number }) {
 const receipts = await tx.posReceipt.aggregate({ where: { companyId, cashSessionId: cash.id, method: 'CASH' }, _sum: { amountCents: true } });
 const refunds = await tx.posRefund.aggregate({ where: { companyId, cashSessionId: cash.id, receipt: { method: 'CASH' } }, _sum: { amountCents: true } });
 const payouts = await tx.posCommissionPayout.aggregate({ where: { companyId, cashSessionId: cash.id, method: 'CASH' }, _sum: { amountCents: true } });
 return cash.openingCents + (receipts._sum.amountCents ?? 0) - (refunds._sum.amountCents ?? 0) - (payouts._sum.amountCents ?? 0);
}
export async function commissionPreview(tx: Pick<Prisma.TransactionClient, 'posCommissionRule'|'posPackageUse'>, sale: Sale) {
 const lines = sale.lines.filter(l => !l.voidedAt), allocation = allocateNet(lines.map(l => ({ id: l.id, gross: l.unitPriceCents * l.quantity })), sale.discountCents);
 const prepaid=await packageFunding(tx,sale.companyId,sale.id);
 const rules = await tx.posCommissionRule.findMany({ where: { companyId: sale.companyId, active: true } });
 return lines.flatMap(l => { const rule = rules.find(r => r.serviceId === l.serviceId && r.professionalId === l.professionalId); if (!rule) return []; const cashBaseCents=allocation.get(l.id)??0,packageBaseCents=prepaid.get(l.id)?.valueCents??0,baseCents=cashBaseCents+packageBaseCents; return [{ lineId: l.id, professionalId: l.professionalId!, baseCents, amountCents: Math.min(baseCents, rule.fixedCents !== null ? rule.fixedCents * l.quantity : Math.floor(baseCents * rule.percentBps! / 10000)), ruleSnapshot: {cashBaseCents,packageBaseCents, id: rule.id, percentBps: rule.percentBps, fixedCents: rule.fixedCents } }]; });
}
export async function generateCommissions(tx: Prisma.TransactionClient, actor: Operator, sale: Sale) {
 for (const row of await commissionPreview(tx, sale)) {
  await tx.posCommission.upsert({ where: { lineId_companyId: { lineId: row.lineId, companyId: sale.companyId } }, create: { companyId: sale.companyId, saleId: sale.id, ...row, originalCents: row.amountCents, status: row.amountCents ? 'GENERATED' : 'REVERSED' }, update: {} });
 }
 await tx.posAudit.create({ data: { companyId: sale.companyId, saleId: sale.id, actorId: actor.userId, action: 'COMMISSIONS_GENERATED', detail: {} } });
}
export async function reconcileCommissions(tx: Prisma.TransactionClient, actor: Operator, sale: CashSale, sourceKey: string) {
 const rows = await tx.posCommission.findMany({ where: { companyId: sale.companyId, saleId: sale.id }, include: { payouts: true } });
 for (const c of rows) {
  const amountCents = await commissionEarned(tx,c,sale,c.originalCents+c.adjustmentCents);
  if (amountCents === c.amountCents) continue;
  const paid = c.payouts.reduce((n,p)=>n+p.amountCents,0);
  await tx.posCommissionAdjustment.create({ data: { companyId: sale.companyId, commissionId: c.id, sourceKey: `${sourceKey}:${c.id}`, deltaCents: amountCents - c.amountCents, reason: 'Estorno proporcional da comanda', actorId: actor.userId } });
  await tx.posCommission.update({ where: { id:c.id }, data: { amountCents, status: !amountCents ? 'REVERSED' : paid >= amountCents ? 'PAID' : c.releasedAt ? 'PAYABLE' : 'GENERATED' } });
 }
}

export async function commissionEarned(tx:Pick<Prisma.TransactionClient,'posPackageUse'>,commission:{lineId:string;companyId:string;baseCents:number;ruleSnapshot:Prisma.JsonValue},sale:CashSale,basis:number){const snapshot=commission.ruleSnapshot&&typeof commission.ruleSnapshot==='object'&&!Array.isArray(commission.ruleSnapshot)?commission.ruleSnapshot:null;const cash=Math.min(sale.totalCents,Math.max(0,netReceived(sale.payments,sale.refunds)));if(!snapshot||typeof snapshot.cashBaseCents!=='number'||typeof snapshot.packageBaseCents!=='number')return sale.totalCents?proportionFloor(basis,cash,sale.totalCents):0;const packageValue=(await packageFunding(tx,commission.companyId,sale.id)).get(commission.lineId)?.valueCents??0,effective=(sale.totalCents?proportionFloor(snapshot.cashBaseCents,cash,sale.totalCents):0)+packageValue;return commission.baseCents?proportionFloor(basis,Math.min(commission.baseCents,effective),commission.baseCents):0;}
