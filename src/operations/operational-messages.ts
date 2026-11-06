import { assertAvailability } from '../bookings/booking-domain.js';
import type { Prisma } from '@prisma/client';
import { entitledWhere } from '../billing/commercial-policy.js';
import { operationalEvent } from '../communication/operational-events.js';
import type { Sale } from './operations.service.js';
type DB=Pick<Prisma.TransactionClient,'customerProfile'|'posMessageConsent'|'companyCommunicationTemplate'|'globalCommunicationOutbox'|'posSale'|'bookingRequest'|'posReceipt'|'posRefund'|'posServiceFollowup'|'subscription'|'waitlistOpportunity'|'waitlistSettings'|'bookingConfirmationInvitation'|'bookingConfirmationSettings'|'posPackageWallet'|'posPackageUse'|'posClientSubscriptionCycle'>;
export async function queueCustomerEvent(tx:DB,companyId:string,customerId:string,event:string,key:string,variables:Prisma.InputJsonObject={}){
 if(!operationalEvent(event))return null;
 const customer=await tx.customerProfile.findFirst({where:{id:customerId,companyId,company:{isActive:true,administrativeStatus:'ACTIVE'}},include:{user:true}});if(!customer?.userId||!customer.user?.isActive||!await tx.subscription.findFirst({where:entitledWhere(companyId)}))return null;
 const consent=await tx.posMessageConsent.findUnique({where:{customerId_companyId:{customerId,companyId}}});if(!consent||(event==='OP_FOLLOW_UP'&&!consent.marketing))return null;
 const requested=(['EMAIL','WHATSAPP','PUSH']as const).filter(channel=>channel==='EMAIL'?consent.email:channel==='WHATSAPP'?consent.whatsapp:consent.push).filter(channel=>!Array.isArray(variables.__allowedChannels)||variables.__allowedChannels.includes(channel));
 const enabled=await tx.companyCommunicationTemplate.findMany({where:{companyId,event,enabled:true,channel:{in:[...requested]}},select:{channel:true}});if(!enabled.length)return null;
 return tx.globalCommunicationOutbox.upsert({where:{businessKey:`POS:${event}:${key}:${customer.userId}`},create:{scope:'COMPANY',event,businessKey:`POS:${event}:${key}:${customer.userId}`,companyId,userId:customer.userId,variables:{servico:'',valor:'',horario:'',pontos:'',...variables,__customerId:customerId,__channels:enabled.map(x=>x.channel)}},update:{}});
}
export async function saleEvent(tx:DB,sale:Sale,event:string,key:string,extra:Prisma.InputJsonObject={}){if(!sale.customerId)return null;return queueCustomerEvent(tx,sale.companyId,sale.customerId,event,key,{__saleId:sale.id,servico:sale.lines.filter(l=>!l.voidedAt).map(l=>l.name).join(', ').slice(0,500),valor:new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(sale.totalCents/100),horario:new Date().toISOString(),pontos:'',...extra});}
export async function scheduleFollowups(tx:Prisma.TransactionClient,sale:Sale){if(!sale.customerId)return;const rules=await tx.posServiceFollowup.findMany({where:{companyId:sale.companyId,enabled:true}});for(const l of sale.lines){const rule=rules.find(r=>r.serviceId===l.serviceId);if(!rule||l.voidedAt||!l.completedAt)continue;await tx.posFollowupJob.upsert({where:{lineId_companyId:{lineId:l.id,companyId:sale.companyId}},create:{companyId:sale.companyId,saleId:sale.id,lineId:l.id,customerId:sale.customerId,dueAt:new Date(l.completedAt.getTime()+rule.delayMinutes*60000)},update:{}});}}
export async function operationalRecipient(db:DB,event:{event:string;companyId:string|null;userId:string|null;variables:Prisma.JsonValue},channel:string){
 if(!operationalEvent(event.event)||!event.companyId||!event.userId||!event.variables||typeof event.variables!=='object'||Array.isArray(event.variables))return null;
 const v=event.variables,customerId=v.__customerId;if(typeof customerId!=='string')return null;
 const customer=await db.customerProfile.findFirst({where:{id:customerId,companyId:event.companyId,userId:event.userId,user:{isActive:true},company:{isActive:true,administrativeStatus:'ACTIVE'}},include:{user:true}});if(!customer?.user)return null;
 const consent=await db.posMessageConsent.findUnique({where:{customerId_companyId:{customerId,companyId:event.companyId}}});if(!consent||(event.event==='OP_FOLLOW_UP'&&!consent.marketing))return null;
 if(channel==='EMAIL'&&(!consent.email||consent.emailSnapshot!==customer.email||customer.email!==customer.user.email))return null;
 if(channel==='WHATSAPP'&&(!consent.whatsapp||!customer.phone||consent.phoneSnapshot!==customer.phone))return null;
 if(channel==='PUSH'&&!consent.push)return null;
 if(!await db.subscription.findFirst({where:entitledWhere(event.companyId)}))return null;
 const configured=await db.companyCommunicationTemplate.findUnique({where:{companyId_event_channel:{companyId:event.companyId,event:event.event,channel:channel as never}}});if(!configured?.enabled)return null;
 if(event.event==='OP_CLIENT_SUBSCRIPTION_PAID'||event.event==='OP_CLIENT_SUBSCRIPTION_DUE'){if(typeof v.__clientCycleId!=='string'||!await db.posClientSubscriptionCycle.findFirst({where:{id:v.__clientCycleId,companyId:event.companyId,status:event.event==='OP_CLIENT_SUBSCRIPTION_PAID'?'PAID':'DUE',subscription:{customerId,...(event.event==='OP_CLIENT_SUBSCRIPTION_DUE'?{status:'SUSPENDED',suspensionReason:'OVERDUE'}:{})},...(event.event==='OP_CLIENT_SUBSCRIPTION_PAID'?{sourceWallet:{status:'ACTIVE',sourceSale:{status:'PAID'}}}:{sourceWalletId:null})}}))return null;return {email:customer.user.email,phone:customer.phone,name:customer.name};}
 if(event.event==='OP_PACKAGE_CREDITED'){if(typeof v.__walletId!=='string'||!await db.posPackageWallet.findFirst({where:{id:v.__walletId,companyId:event.companyId,customerId,status:'ACTIVE',sourceSale:{status:'PAID'}}}))return null;return {email:customer.user.email,phone:customer.phone,name:customer.name};}
 if(event.event==='OP_PACKAGE_USED'||event.event==='OP_PACKAGE_RESTORED'){if(typeof v.__packageUseId!=='string'||!await db.posPackageUse.findFirst({where:{id:v.__packageUseId,companyId:event.companyId,status:event.event==='OP_PACKAGE_USED'?'CONSUMED':'REVERSED',session:{wallet:{customerId}}}}))return null;return {email:customer.user.email,phone:customer.phone,name:customer.name};}
 if(event.event==='OP_APPOINTMENT_CONFIRMATION'){
 if(typeof v.__confirmationInvitationId!=='string'||!await db.bookingConfirmationSettings.findFirst({where:{companyId:event.companyId,enabled:true,channels:{has:channel}}})||!await db.bookingConfirmationInvitation.findFirst({where:{id:v.__confirmationInvitationId,companyId:event.companyId,usedAt:null,expiresAt:{gt:new Date()},confirmation:{response:null,startsAt:{gt:new Date()},request:{customerId,status:'CONFIRMED'}}}}))return null;
 return {email:customer.user.email,phone:customer.phone,name:customer.name};}
 if(event.event==='OP_WAITLIST_AVAILABLE'){
 if(typeof v.__opportunityId!=='string'||!await db.waitlistSettings.findFirst({where:{companyId:event.companyId,enabled:true}}))return null;
 const offer=await db.waitlistOpportunity.findFirst({where:{id:v.__opportunityId,companyId:event.companyId,status:'OFFERED',expiresAt:{gt:new Date()},startsAt:{gt:new Date()},entry:{customerId,status:'WAITING'}},include:{entry:{include:{service:true,company:{select:{timezone:true}}}},professional:{include:{availability:true,membership:true}}}});
 if(!offer||!offer.entry.service.active||!offer.entry.service.public||!offer.professional.active||!offer.professional.membership.isActive||!['OWNER','ADMIN','PROFESSIONAL'].includes(offer.professional.membership.role))return null;
 try{assertAvailability(offer.startsAt,offer.entry.service.durationMinutes,offer.entry.company.timezone,offer.professional.availability.filter(a=>a.active));}catch{return null;}
 const end=new Date(offer.startsAt.getTime()+offer.entry.service.durationMinutes*60000);
 if(await db.bookingRequest.findFirst({where:{companyId:event.companyId,OR:[{status:'CONFIRMED'},{status:'REQUESTED',holdExpiresAt:{gt:new Date()}}],items:{some:{professionalId:offer.professionalId,startsAt:{lt:end},endsAt:{gt:offer.startsAt}}}}}))return null;
 return {email:customer.user.email,phone:customer.phone,name:customer.name};}

 if(event.event.startsWith('OP_BOOKING_')){if(typeof v.__bookingId!=='string')return null;const expected=event.event==='OP_BOOKING_REQUESTED'?'REQUESTED':event.event==='OP_BOOKING_CONFIRMED'?'CONFIRMED':'REJECTED';if(!await db.bookingRequest.findFirst({where:{id:v.__bookingId,companyId:event.companyId,customerId,status:expected}}))return null;}
 else{
  if(typeof v.__saleId!=='string')return null;const sale=await db.posSale.findFirst({where:{id:v.__saleId,companyId:event.companyId,customerId},include:{lines:true}});if(!sale)return null;
  if(['OP_SALE_PAID','OP_FOLLOW_UP','OP_LOYALTY_CONFIRMED'].includes(event.event)&&sale.status!=='PAID')return null;
  if(event.event==='OP_SALE_CANCELLED'&&sale.status!=='CANCELLED')return null;
  if(['OP_ATTENDANCE_STARTED','OP_SERVICE_COMPLETED'].includes(event.event)){const line=sale.lines.find(l=>l.id===v.__lineId);if(!line||line.voidedAt||!line.startedAt||(event.event==='OP_SERVICE_COMPLETED'&&!line.completedAt)||['CANCELLED','REFUNDED'].includes(sale.status))return null;}
  if(event.event==='OP_FOLLOW_UP'){const line=sale.lines.find(l=>l.id===v.__lineId);if(!line?.completedAt||line.voidedAt||!line.serviceId||!await db.posServiceFollowup.findFirst({where:{companyId:event.companyId,serviceId:line.serviceId,enabled:true}}))return null;}
  if(event.event==='OP_RECEIPT_RECORDED'){if(typeof v.__factId!=='string')return null;const receipt=await db.posReceipt.findFirst({where:{id:v.__factId,companyId:event.companyId,saleId:sale.id},include:{refunds:true}});if(!receipt||receipt.refunds.reduce((n,r)=>n+r.amountCents,0)>=receipt.amountCents)return null;}
  if(event.event==='OP_REFUND_RECORDED'&&(typeof v.__factId!=='string'||!await db.posRefund.findFirst({where:{id:v.__factId,companyId:event.companyId,saleId:sale.id}})))return null;
 }
 return {email:customer.user.email,phone:customer.phone,name:customer.name};
}
