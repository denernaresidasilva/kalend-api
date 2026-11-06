import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
export async function validateWaitlistConversion(tx:Prisma.TransactionClient,companyId:string,customerId:string,id:string,items:Array<{serviceId:string;professionalId:string;startsAt:Date}>){
 await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${companyId+':waitlist'},0))::text`;
 const opportunity=await tx.waitlistOpportunity.findFirst({where:{id,companyId,status:'OFFERED',expiresAt:{gt:new Date()},entry:{customerId,status:'WAITING',customer:{userId:{not:null}}}}});
 if(!opportunity||!await tx.waitlistSettings.findFirst({where:{companyId,enabled:true}}))throw new ConflictException('Oportunidade expirada ou indisponível.');
 const entry=await tx.waitlistEntry.findUniqueOrThrow({where:{id:opportunity.entryId}});
 if(!items.some(i=>i.serviceId===entry.serviceId&&i.professionalId===opportunity.professionalId&&i.startsAt.getTime()===opportunity.startsAt.getTime()))throw new ConflictException('Escolha o serviço e o horário desta oportunidade.');return opportunity;
}
export async function completeWaitlistConversion(tx:Prisma.TransactionClient,companyId:string,requestId:string,customerId:string,decision:string,items:Array<{serviceId:string;professionalId:string}>){
 const opportunity=await tx.waitlistOpportunity.findFirst({where:{companyId,requestId}});if(opportunity)await tx.waitlistOpportunity.update({where:{id:opportunity.id},data:{status:decision==='CONFIRMED'?'CONVERTED':decision==='CANCELLED'?'CANCELLED':'REJECTED'}});
 const cfg=await tx.waitlistSettings.findUnique({where:{companyId}});if(decision==='CONFIRMED'&&cfg?.cancelOnConfirmation){const entries=await tx.waitlistEntry.findMany({where:{companyId,customerId,status:'WAITING',OR:items.map(i=>({serviceId:i.serviceId,OR:[{professionalId:null},{professionalId:i.professionalId}]}))},select:{id:true}});const ids=entries.map(e=>e.id);await tx.waitlistEntry.updateMany({where:{companyId,id:{in:ids}},data:{status:'FULFILLED'}});await tx.waitlistOpportunity.updateMany({where:{companyId,entryId:{in:ids},status:'OFFERED'},data:{status:'CANCELLED'}});}
}
