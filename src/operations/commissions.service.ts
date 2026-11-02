import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { proportionFloor, netReceived } from './pos-domain.js';
import type { PosPaymentMethod } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { OperationsService, type Operator } from './operations.service.js';
import { cashBalance, commissionPreview } from './commission-domain.js';
import { integer, object, string, uuid } from '../common/validation.js';
@Injectable()
export class CommissionsService {
 constructor(@Inject(PrismaService) private readonly db: PrismaService, @Inject(OperationsService) private readonly ops: OperationsService) {}
 async rules(actor: Operator, input: unknown) {
  const b=object(input,['professionalId','serviceId','percentBps','fixedCents']);const professionalId=uuid(b.professionalId),serviceId=uuid(b.serviceId);
  if((b.percentBps!==undefined)===(b.fixedCents!==undefined))throw new BadRequestException('Escolha percentual ou valor fixo.');
  if(b.percentBps!==undefined)integer(b.percentBps,'percentBps',0,10000);if(b.fixedCents!==undefined)integer(b.fixedCents,'fixedCents',0,100_000_000);
  return this.ops.change(actor,['OWNER','ADMIN'],async tx=>{
   const professional=await tx.professionalProfile.findFirst({where:{id:professionalId,companyId:actor.companyId,active:true,membership:{isActive:true,role:{in:['OWNER','ADMIN','PROFESSIONAL']}},services:{some:{serviceId}}}});if(!professional)throw new BadRequestException('Profissional ou serviço não pertence à empresa.');
   const data={percentBps:(b.percentBps??null)as number|null,fixedCents:(b.fixedCents??null)as number|null,active:true};
   const rule=await tx.posCommissionRule.upsert({where:{professionalId_serviceId_companyId:{professionalId,serviceId,companyId:actor.companyId}},create:{companyId:actor.companyId,professionalId,serviceId,...data},update:data});
   await tx.posAudit.create({data:{companyId:actor.companyId,actorId:actor.userId,action:'COMMISSION_RULE_SAVED',detail:{ruleId:rule.id,...data}}});await this.ops.notify(tx,actor.companyId,[professionalId]);return rule;
  });
 }
 async list(actor: Operator){
  if(!['OWNER','ADMIN','PROFESSIONAL'].includes(actor.role))throw new BadRequestException('Papel sem acesso às comissões.');
  const own=actor.role==='PROFESSIONAL'?{professional:{membershipId:actor.membershipId}}:{};
  const rows=await this.db.posCommission.findMany({where:{companyId:actor.companyId,...own},include:{professional:{select:{displayName:true}},line:{select:{name:true}},adjustments:{orderBy:{createdAt:'asc'}},payouts:{orderBy:{createdAt:'asc'}}},orderBy:{createdAt:'desc'},take:200});
  const sales=await this.db.posSale.findMany({where:{companyId:actor.companyId,status:{in:['OPEN','IN_PROGRESS','AWAITING_PAYMENT']}},include:{customer:{select:{id:true,name:true}},lines:{include:{professional:{select:{id:true,membershipId:true,displayName:true}}},orderBy:{createdAt:'asc'}},payments:true,refunds:true}});
  const preview=[];for(const sale of sales){for(const row of await commissionPreview(this.db,sale)){const line=sale.lines.find(l=>l.id===row.lineId)!;if(actor.role==='PROFESSIONAL'&&line.professional?.membershipId!==actor.membershipId)continue;preview.push({...row,service:line.name,professional:line.professional?.displayName,saleId:sale.id});}}
  const rules=actor.role==='PROFESSIONAL'?[]:await this.db.posCommissionRule.findMany({where:{companyId:actor.companyId}});
  return{preview,rules,commissions:rows.map(c=>{const paidCents=c.payouts.reduce((n,p)=>n+p.amountCents,0);return{...c,paidCents,payableCents:Math.max(0,c.amountCents-paidCents),recoveryCents:Math.max(0,paidCents-c.amountCents)};})};
 }
 async release(actor:Operator,id:string){return this.ops.change(actor,['OWNER','ADMIN'],async tx=>{const c=await tx.posCommission.findFirst({where:{id,companyId:actor.companyId}});if(!c)throw new NotFoundException('Comissão não encontrada.');if(c.status!=='GENERATED')return c;const result=await tx.posCommission.update({where:{id},data:{status:'PAYABLE',releasedAt:new Date(),releasedById:actor.userId}});await this.ops.notify(tx,actor.companyId,[c.professionalId]);return result;});}
 async pay(actor:Operator,id:string,input:unknown){
  const b=object(input,['idempotencyKey','amountCents','method','reference','confirmed']);const key=uuid(b.idempotencyKey);integer(b.amountCents,'amountCents',1,100_000_000);const reference=string(b.reference,'reference',160);if(b.confirmed!==true||!['CASH','PIX','TRANSFER','OTHER'].includes(String(b.method)))throw new BadRequestException('Confira o pagamento e o método.');
  return this.ops.change(actor,['OWNER','ADMIN'],async tx=>{
   const old=await tx.posCommissionPayout.findUnique({where:{companyId_idempotencyKey:{companyId:actor.companyId,idempotencyKey:key}}});if(old){if(old.commissionId!==id||old.amountCents!==b.amountCents||old.reference!==reference||old.method!==b.method)throw new ConflictException('Chave já utilizada.');return old;}
   const c=await tx.posCommission.findFirst({where:{id,companyId:actor.companyId},include:{payouts:true}});if(!c)throw new NotFoundException('Comissão não encontrada.');const paid=c.payouts.reduce((n,p)=>n+p.amountCents,0);if(c.status!=='PAYABLE'||paid+(b.amountCents as number)>c.amountCents)throw new ConflictException('Comissão não liberada ou valor maior que o saldo.');
   const cash=b.method==='CASH'?await tx.posCashSession.findFirst({where:{companyId:actor.companyId,closedAt:null}}):null;if(b.method==='CASH'&&(!cash||await cashBalance(tx,actor.companyId,cash)<(b.amountCents as number)))throw new ConflictException('Caixa fechado ou saldo insuficiente.');
   const payout=await tx.posCommissionPayout.create({data:{companyId:actor.companyId,commissionId:id,idempotencyKey:key,amountCents:b.amountCents as number,method:b.method as PosPaymentMethod,reference,cashSessionId:cash?.id,actorId:actor.userId}});if(paid+payout.amountCents===c.amountCents)await tx.posCommission.update({where:{id},data:{status:'PAID'}});
   await tx.posAudit.create({data:{companyId:actor.companyId,saleId:c.saleId,actorId:actor.userId,action:'COMMISSION_PAID',detail:{commissionId:id,payoutId:payout.id,amountCents:payout.amountCents}}});await this.ops.notify(tx,actor.companyId,[c.professionalId]);return payout;
  });
 }
 async adjust(actor:Operator,id:string,input:unknown){
  const b=object(input,['deltaCents','reason','idempotencyKey']);integer(b.deltaCents,'deltaCents',-100_000_000,100_000_000);const reason=string(b.reason,'reason',1000),key=uuid(b.idempotencyKey),requestHash=createHash('sha256').update(JSON.stringify({delta:b.deltaCents,reason,id})).digest('hex');
  return this.ops.change(actor,['OWNER','ADMIN'],async tx=>{const old=await tx.posCommissionAdjustment.findUnique({where:{companyId_sourceKey:{companyId:actor.companyId,sourceKey:key}}});if(old){if(old.commissionId!==id||old.requestHash!==requestHash)throw new ConflictException('Chave já utilizada.');return old;}
   const c=await tx.posCommission.findFirst({where:{id,companyId:actor.companyId},include:{sale:{include:{refunds:true,payments:true}},payouts:true}});if(!c)throw new NotFoundException('Comissão não encontrada.');const adjustmentCents=c.adjustmentCents+(b.deltaCents as number),basis=c.originalCents+adjustmentCents;if(basis<0||basis>c.baseCents)throw new BadRequestException('Ajuste fora do valor líquido do serviço.');const settled=Math.min(c.sale.totalCents,Math.max(0,netReceived(c.sale.payments,c.sale.refunds))),amountCents=c.sale.totalCents?proportionFloor(basis,settled,c.sale.totalCents):0,paid=c.payouts.reduce((n,p)=>n+p.amountCents,0);
   const adjustment=await tx.posCommissionAdjustment.create({data:{companyId:actor.companyId,commissionId:id,sourceKey:key,requestHash,deltaCents:amountCents-c.amountCents,reason,actorId:actor.userId}});await tx.posCommission.update({where:{id},data:{adjustmentCents,amountCents,status:!amountCents?'REVERSED':paid>=amountCents?'PAID':c.releasedAt?'PAYABLE':'GENERATED'}});await this.ops.notify(tx,actor.companyId,[c.professionalId]);return adjustment;
  });
 }
}
