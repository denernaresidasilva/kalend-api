import type { Prisma } from '@prisma/client';
import type { Sale } from './operations.service.js';
import { netReceived } from './pos-domain.js';
import { saleEvent } from './operational-messages.js';
export async function confirmLoyalty(tx:Prisma.TransactionClient,sale:Sale){
 if(!sale.customerId||!sale.lines.some(l=>l.serviceId&&l.completedAt&&!l.voidedAt)||sale.totalCents<=0)return;
 const settings=await tx.posLoyaltySettings.findUnique({where:{companyId:sale.companyId}});
 if(!settings?.enabled||netReceived(sale.payments,sale.refunds)!==sale.totalCents||sale.totalCents<settings.minPaidCents)return;
 const customer=await tx.customerProfile.findFirst({where:{id:sale.customerId,companyId:sale.companyId,userId:{not:null},user:{isActive:true}}});if(!customer)return;
 const card=await tx.posLoyaltyCard.upsert({where:{customerId_companyId:{customerId:customer.id,companyId:sale.companyId}},create:{companyId:sale.companyId,customerId:customer.id},update:{}});
 const points=Number(BigInt(sale.totalCents)/BigInt(settings.spendCents)*BigInt(settings.points));
 const create=async(cardId:string,kind:string,n:number,key:string)=>tx.posLoyaltyEntry.upsert({where:{companyId_sourceKey:{companyId:sale.companyId,sourceKey:key}},create:{companyId:sale.companyId,cardId,saleId:sale.id,sourceKey:key,delta:n,originalPoints:n,basisCents:sale.totalCents,minPaidCents:settings.minPaidCents,kind},update:{}});
 if(points)await create(card.id,'EARN',points,`EARN:${sale.id}`);
 if(card.referrerId&&settings.referralPoints>0&&!await tx.posLoyaltyEntry.findFirst({where:{companyId:sale.companyId,sourceKey:`REFERRAL:${card.id}`}}))await create(card.referrerId,'REFERRAL',settings.referralPoints,`REFERRAL:${card.id}`);
 if(points)await saleEvent(tx,sale,'OP_LOYALTY_CONFIRMED',sale.id,{pontos:String(points)});
}
export async function reverseLoyalty(tx:Prisma.TransactionClient,sale:Sale,refundId:string){
 const originals=await tx.posLoyaltyEntry.findMany({where:{companyId:sale.companyId,saleId:sale.id,kind:{in:['EARN','REFERRAL']}}});
 const net=Math.max(0,netReceived(sale.payments,sale.refunds));
 for(const row of originals){const ledger=await tx.posLoyaltyEntry.aggregate({where:{companyId:sale.companyId,saleId:sale.id,cardId:row.cardId,kind:row.kind==='EARN'?{in:['EARN','EARN_REVERSAL']}:{in:['REFERRAL','REFERRAL_REVERSAL']}},_sum:{delta:true}});
 const target=net<row.minPaidCents?0:row.kind==='REFERRAL'?row.originalPoints:Number(BigInt(row.originalPoints)*BigInt(Math.min(net,row.basisCents))/BigInt(row.basisCents));const delta=target-(ledger._sum.delta??0);
 if(delta)await tx.posLoyaltyEntry.create({data:{companyId:sale.companyId,cardId:row.cardId,saleId:sale.id,sourceKey:`REV:${row.id}:${refundId}`,delta,kind:`${row.kind}_REVERSAL`,originalPoints:row.originalPoints,basisCents:row.basisCents,minPaidCents:row.minPaidCents}});
 }
}
