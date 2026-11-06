import { clientBenefits,subscriptionBonusRatio } from './client-subscription-domain.js';
import { effectiveLoyaltyValue,type CashSale } from './package-funding.js';
import type { Prisma } from '@prisma/client';
import type { Sale } from './operations.service.js';
import { netReceived } from './pos-domain.js';
import { saleEvent } from './operational-messages.js';
export async function confirmLoyalty(tx:Prisma.TransactionClient,sale:Sale){
 if(!sale.customerId||!sale.lines.some(l=>l.serviceId&&l.completedAt&&!l.voidedAt))return;
 const settings=await tx.posLoyaltySettings.findUnique({where:{companyId:sale.companyId}});
 const effective=await effectiveLoyaltyValue(tx,sale);
 if(!settings?.enabled||effective<=0||netReceived(sale.payments,sale.refunds)!==sale.totalCents||effective<settings.minPaidCents)return;
 const customer=await tx.customerProfile.findFirst({where:{id:sale.customerId,companyId:sale.companyId,userId:{not:null},user:{isActive:true}}});if(!customer)return;
 const card=await tx.posLoyaltyCard.upsert({where:{customerId_companyId:{customerId:customer.id,companyId:sale.companyId}},create:{companyId:sale.companyId,customerId:customer.id},update:{}});
 const points=Number(BigInt(effective)/BigInt(settings.spendCents)*BigInt(settings.points));
 const create=async(cardId:string,kind:string,n:number,key:string)=>tx.posLoyaltyEntry.upsert({where:{companyId_sourceKey:{companyId:sale.companyId,sourceKey:key}},create:{companyId:sale.companyId,cardId,saleId:sale.id,sourceKey:key,delta:n,originalPoints:n,basisCents:effective,minPaidCents:settings.minPaidCents,kind},update:{}});
 if(points)await create(card.id,'EARN',points,`EARN:${sale.id}`);
 const completed=sale.lines.filter(l=>l.completedAt&&!l.voidedAt).map(l=>l.completedAt!).sort((a,b)=>b.getTime()-a.getTime())[0]??new Date();const benefit=await clientBenefits(tx,sale.companyId,sale.customerId,completed);if(benefit.bonusPoints>0&&benefit.bonusCycleId)await tx.posLoyaltyEntry.upsert({where:{companyId_sourceKey:{companyId:sale.companyId,sourceKey:'MEMBERSHIP_BONUS:'+sale.id}},create:{companyId:sale.companyId,cardId:card.id,saleId:sale.id,sourceKey:'MEMBERSHIP_BONUS:'+sale.id,delta:benefit.bonusPoints,originalPoints:benefit.bonusPoints,basisCents:effective,minPaidCents:settings.minPaidCents,kind:'MEMBERSHIP_BONUS',clientSubscriptionCycleId:benefit.bonusCycleId},update:{}});
 if(card.referrerId&&settings.referralPoints>0&&!await tx.posLoyaltyEntry.findFirst({where:{companyId:sale.companyId,sourceKey:`REFERRAL:${card.id}`}}))await create(card.referrerId,'REFERRAL',settings.referralPoints,`REFERRAL:${card.id}`);
 if(points||benefit.bonusPoints)await saleEvent(tx,sale,'OP_LOYALTY_CONFIRMED',sale.id,{pontos:String(points+benefit.bonusPoints)});
}
export async function reverseLoyalty(tx:Prisma.TransactionClient,sale:CashSale,refundId:string){
 const originals=await tx.posLoyaltyEntry.findMany({where:{companyId:sale.companyId,saleId:sale.id,kind:{in:['EARN','REFERRAL','MEMBERSHIP_BONUS']}}});
 const net=await effectiveLoyaltyValue(tx,sale);
 for(const row of originals){const ledger=await tx.posLoyaltyEntry.aggregate({where:{companyId:sale.companyId,saleId:sale.id,cardId:row.cardId,kind:{in:[row.kind,row.kind+'_REVERSAL']}},_sum:{delta:true}});
 let target=net<row.minPaidCents?0:row.kind==='REFERRAL'?row.originalPoints:Number(BigInt(row.originalPoints)*BigInt(Math.min(net,row.basisCents))/BigInt(row.basisCents));if(row.kind==='MEMBERSHIP_BONUS'&&row.clientSubscriptionCycleId)target=await subscriptionBonusRatio(tx,sale.companyId,row.clientSubscriptionCycleId,target);const delta=target-(ledger._sum.delta??0);
 if(delta)await tx.posLoyaltyEntry.create({data:{companyId:sale.companyId,cardId:row.cardId,saleId:sale.id,sourceKey:`REV:${row.id}:${refundId}`,delta,kind:`${row.kind}_REVERSAL`,originalPoints:row.originalPoints,basisCents:row.basisCents,minPaidCents:row.minPaidCents,clientSubscriptionCycleId:row.clientSubscriptionCycleId}});
 }
}
