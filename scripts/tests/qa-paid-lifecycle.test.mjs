import test from 'node:test';import assert from 'node:assert/strict';
import {requireQaPayment,probeQaPeriodImmutability,reverseQaPayment} from '../qa/paid-lifecycle.mjs';
const input={runId:'QA-E2E-SA-0123456789abcdef',companyId:'qa',paymentId:'qa'};
test('operator helpers reject non-QA company and provider money before mutation',async()=>{
 for(const [name,gateway] of [['Real company','QA_SIMULATION'],[input.runId+'-A','PAGBANK']]){
  const tx={company:{findUnique:async()=>({name})},payment:{findFirst:async()=>({gateway,environment:'SANDBOX',subscription:{gateway}})}};
  await assert.rejects(requireQaPayment(tx,input));
 }
});
test('immutability probe rejects unpaid fixture and reversal rejects arbitrary operations',async()=>{
 const tx={company:{findUnique:async()=>({name:input.runId+'-A'})},payment:{findFirst:async()=>({gateway:'QA_SIMULATION',environment:'SANDBOX',subscription:{gateway:'QA_SIMULATION'},status:'PENDING'})}};
 const db={$transaction:async fn=>fn(tx)};
 await assert.rejects(probeQaPeriodImmutability(db,input));await assert.rejects(reverseQaPayment(db,{}, {...input,action:'DELETE'}));
});
