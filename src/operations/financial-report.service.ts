import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { Operator } from './operations.service.js';
import { localMinuteToUtc } from '../bookings/booking-domain.js';
@Injectable()
export class FinancialReportService {
 constructor(@Inject(PrismaService) private readonly db: PrismaService) {}
 async report(actor:Operator,query:Record<string,string>={}) {
  if(!['OWNER','ADMIN','ACCOUNTANT'].includes(actor.role))throw new ForbiddenException('Relatório financeiro não autorizado.');
  if(Object.keys(query).some(k=>!['from','to'].includes(k)))throw new BadRequestException('Filtro inválido.');
  const company=await this.db.company.findUniqueOrThrow({where:{id:actor.companyId},select:{timezone:true}}),today=new Intl.DateTimeFormat('en-CA',{timeZone:company.timezone}).format(new Date());
  const from=query.from??today.slice(0,8)+'01',to=query.to??today;
  for(const date of[from,to]){if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new BadRequestException('Data inválida.');const d=new Date(date+'T12:00:00Z');if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==date)throw new BadRequestException('Data inválida.');}
  const next=new Date(to+'T12:00:00Z');next.setUTCDate(next.getUTCDate()+1);const start=localMinuteToUtc(from,0,company.timezone),end=localMinuteToUtc(next.toISOString().slice(0,10),0,company.timezone);
  if(start>=end||end.getTime()-start.getTime()>367*86400000)throw new BadRequestException('Escolha um período de até um ano.');
  return this.db.$transaction(async tx=>{
   const where={companyId:actor.companyId,createdAt:{gte:start,lt:end}};
   const [received,returned,paid,receipts,refunds,payouts,drawer]=await Promise.all([
    tx.posReceipt.aggregate({where,_sum:{amountCents:true},_count:true}),tx.posRefund.aggregate({where,_sum:{amountCents:true},_count:true}),tx.posCommissionPayout.aggregate({where,_sum:{amountCents:true},_count:true}),
    tx.posReceipt.findMany({where,select:{id:true,saleId:true,createdAt:true,method:true,amountCents:true,reference:true},orderBy:{createdAt:'desc'},take:200}),tx.posRefund.findMany({where,select:{id:true,saleId:true,createdAt:true,amountCents:true,reason:true},orderBy:{createdAt:'desc'},take:200}),tx.posCommissionPayout.findMany({where,select:{id:true,commissionId:true,createdAt:true,amountCents:true,method:true,reference:true},orderBy:{createdAt:'desc'},take:200}),tx.posCashSession.findMany({where:{companyId:actor.companyId,openedAt:{gte:start,lt:end}},select:{id:true,openedAt:true,closedAt:true,openingCents:true,expectedCents:true,countedCents:true,differenceCents:true},orderBy:{openedAt:'desc'},take:200}),
   ]);
   return {period:{from,to,timezone:company.timezone},totals:{receivedCents:received._sum.amountCents??0,refundedCents:returned._sum.amountCents??0,commissionPaidCents:paid._sum.amountCents??0,netReceivedCents:(received._sum.amountCents??0)-(returned._sum.amountCents??0)},receipts,refunds,payouts,cashSessions:drawer,truncated:received._count>200||returned._count>200||paid._count>200};
  },{isolationLevel:'RepeatableRead'});
 }
}
