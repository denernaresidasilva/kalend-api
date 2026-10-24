/** Operator integration helpers; only new, explicitly named QA fixtures and QA_SIMULATION money. */
export async function requireQaPayment(tx, input) {
  if (!/^QA-E2E-SA-[0-9a-f]{16}$/.test(input.runId)) throw Error('QA_RUN_REQUIRED');
  const company=await tx.company.findUnique({where:{id:input.companyId}});
  if(!company?.name.startsWith(input.runId+'-'))throw Error('QA_COMPANY_REQUIRED');
  const payment=await tx.payment.findFirst({where:{id:input.paymentId,companyId:input.companyId},include:{subscription:true}});
  if(!payment||payment.gateway!=='QA_SIMULATION'||payment.environment!=='SANDBOX'||payment.subscription?.gateway!=='QA_SIMULATION')throw Error('SIMULATED_QA_PAYMENT_REQUIRED');
  return payment;
}
export async function probeQaPeriodImmutability(db,input) {
  try {
    await db.$transaction(async tx=>{
      const p=await requireQaPayment(tx,input);
      if(p.status!=='APPROVED')throw Error('APPROVED_QA_REQUIRED');
      await tx.payment.update({where:{id:p.id},data:{periodEnd:new Date(Date.now()-86400000)}});
      throw Error('EXPECTED_IMMUTABILITY_NOT_ENFORCED'); // force rollback even if a database lacks the trigger
    },{isolationLevel:'Serializable'});
  } catch(error) {
    if((String(error)+JSON.stringify(error)).includes('PAYMENT_EVIDENCE_SCOPE_IMMUTABLE'))return {periodImmutabilityEnforced:true};
    throw error;
  }
}
export async function createHistoricalQaProof(db,input) {
  return db.$transaction(async tx=>{
    if(!/^QA-E2E-SA-[0-9a-f]{16}$/.test(input.runId))throw Error('QA_RUN_REQUIRED');
    const company=await tx.company.findUnique({where:{id:input.companyId}});
    const plan=await tx.plan.findUnique({where:{id:input.planId}});
    if(!company?.name.startsWith(input.runId+'-')||plan?.name!==input.runId)throw Error('QA_FIXTURE_REQUIRED');
    const end=new Date(Date.now()-86400000),start=new Date(end);start.setUTCMonth(start.getUTCMonth()-1);
    const sub=await tx.subscription.create({data:{companyId:company.id,planId:plan.id,status:'ACTIVE',gateway:'QA_SIMULATION',environment:'SANDBOX',currentPeriodStart:start,currentPeriodEnd:end,expectedAmountCents:1000}});
    const payment=await tx.payment.create({data:{companyId:company.id,subscriptionId:sub.id,planId:plan.id,gateway:'QA_SIMULATION',environment:'SANDBOX',status:'APPROVED',creationState:'CREATED',amountCents:1000,periodStart:start,periodEnd:end,paidAt:new Date(end.getTime()-86400000),description:'QA historical fixture; no real payment'}});
    const right=await tx.subscriptionEntitlement.create({data:{subscriptionId:sub.id,origin:'PAYMENT',startsAt:start,endsAt:end}});
    await tx.paymentEvidence.create({data:{paymentId:payment.id,companyId:company.id,subscriptionId:sub.id,entitlementId:right.id,startsAt:start,endsAt:end,status:'APPLIED'}});
    await tx.company.update({where:{id:company.id},data:{status:'ACTIVE',isActive:true}});
    await tx.$executeRawUnsafe(`UPDATE "GlobalCommunicationOutbox" SET "businessKey"='QA_SIMULATION:DOMAIN:'||id::text||':'||"businessKey" WHERE "companyId"=$1::uuid AND ("businessKey" LIKE ('PAYMENT_%:'||$2) OR "businessKey" LIKE ('SUBSCRIPTION_%:'||$3||':%'))`,company.id,payment.id,sub.id);
    return {paymentId:payment.id,subscriptionId:sub.id,source:'new historical QA_SIMULATION fixture; no existing evidence edited'};
  },{isolationLevel:'Serializable'});
}
export async function reverseQaPayment(db,domain,input) {
  if(!['PARTIAL_REFUND','FULL_REFUND','CHARGEBACK'].includes(input.action))throw Error('QA_REVERSAL_ACTION_REQUIRED');
  return db.$transaction(async tx=>{
    const p=await requireQaPayment(tx,input);
    const eventId=`QA_SIMULATION:${p.id}:${input.action}`;
    const existing=await tx.webhookEvent.findUnique({where:{gateway_environment_externalEventId:{gateway:'QA_SIMULATION',environment:'SANDBOX',externalEventId:eventId}}});
    if(existing)return {duplicate:true};
    const amount=input.action==='PARTIAL_REFUND'?Math.max(1,Math.floor(p.amountCents/10)):p.amountCents;
    await domain.payment(tx,'QA_SIMULATION',{kind:'payment',environment:'SANDBOX',eventId,type:input.action==='CHARGEBACK'?'PAYMENT_CHARGEBACK':'PAYMENT_REFUNDED',externalPaymentId:`QA_SIMULATION:${p.id}`,externalReference:p.id,companyId:p.companyId,planId:p.planId,status:input.action==='CHARGEBACK'?'FAILED':'REFUNDED',amountCents:p.amountCents,refundedAmountCents:amount,currency:p.currency});
    await tx.webhookEvent.create({data:{gateway:'QA_SIMULATION',environment:'SANDBOX',externalEventId:eventId,eventType:input.action,companyId:p.companyId,paymentId:p.id,status:'PROCESSED',processedAt:new Date(),payload:{source:'QA_SIMULATION',layer:'operator domain integration',action:input.action}}});
    await tx.$executeRawUnsafe(`UPDATE "GlobalCommunicationOutbox" SET "businessKey"='QA_SIMULATION:DOMAIN:'||id::text||':'||"businessKey" WHERE "companyId"=$1::uuid AND ("businessKey" LIKE ('PAYMENT_%:'||$2) OR "businessKey" LIKE ('SUBSCRIPTION_%:'||$3||':%'))`,p.companyId,p.id,p.subscriptionId);
    return {duplicate:false,action:input.action};
  },{isolationLevel:'Serializable'});
}
export async function createExpiredQaTrial(db,input) {
  if(!/^QA-E2E-SA-[0-9a-f]{16}$/.test(input.runId))throw Error('QA_RUN_REQUIRED');
  return db.$transaction(async tx=>{
    const owner=await tx.user.findUnique({where:{id:input.ownerId}}),plan=await tx.plan.findUnique({where:{id:input.planId}});
    if(owner?.name!==input.runId+'-OWNER_A'||owner.isSuperAdmin||plan?.name!==input.runId)throw Error('QA_OWNER_AND_PLAN_REQUIRED');
    const company=await tx.company.create({data:{name:input.runId+(input.expiring?'-F':'-E'),slug:input.runId.toLowerCase()+(input.expiring?'-f':'-e'),status:'TRIAL'}});
    await tx.membership.create({data:{userId:owner.id,companyId:company.id,role:'OWNER'}});
    const sub=await tx.subscription.create({data:{companyId:company.id,planId:plan.id,status:'TRIALING',gateway:input.expiring?'MANUAL':'QA_SIMULATION',environment:'SANDBOX',trialStartedAt:new Date(Date.now()-(input.expiring?5:8)*86400000),trialEndsAt:new Date(Date.now()+(input.expiring?2:-1)*86400000)}});
    await tx.$executeRawUnsafe(`UPDATE "GlobalCommunicationOutbox" SET "businessKey"='QA_SIMULATION:DOMAIN:'||id::text||':'||"businessKey" WHERE "companyId"=$1::uuid AND "businessKey" NOT LIKE 'QA_SIMULATION:%'`,company.id);
    return {companyId:company.id,subscriptionId:sub.id};
  });
}
export async function expireQaTrial(db,domain,input) {
  return db.$transaction(async tx=>{
    const company=await tx.company.findUnique({where:{id:input.companyId}}),sub=await tx.subscription.findUnique({where:{id:input.subscriptionId}});
    if(!/^QA-E2E-SA-[0-9a-f]{16}$/.test(input.runId)||company?.name!==input.runId+'-E'||sub?.companyId!==company.id||sub.gateway!=='QA_SIMULATION'||!sub.trialEndsAt||sub.trialEndsAt>new Date())throw Error('EXPIRED_QA_TRIAL_REQUIRED');
    await domain.elapsed(tx,sub,new Date());
    await tx.$executeRawUnsafe(`UPDATE "GlobalCommunicationOutbox" SET "businessKey"='QA_SIMULATION:DOMAIN:'||id::text||':'||"businessKey" WHERE "companyId"=$1::uuid AND "businessKey" NOT LIKE 'QA_SIMULATION:%'`,company.id);
    return {expiredQaTrialCaptured:true};
  });
}
