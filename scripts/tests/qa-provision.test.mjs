import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareIdentityPlan } from '../qa/prepare-dev-identities.mjs';
import { validateQaSeed, provisionQaIdentities } from '../qa/provision-dev-identities.mjs';
function seed(){const p=prepareIdentityPlan();for(const a of p.accounts){delete a.password;a.passwordHash='$2b$12$'+'x'.repeat(53);}return p;}
test('seed cannot reuse real identities, wrong database, provisioned input or altered tenant names',()=>{
 for(const mutate of [p=>p.database='kalend',p=>p.provisioned=true,p=>p.accounts[0].email='real@example.com',p=>p.companies[0].name='Real tenant',p=>p.accounts[1].id=p.accounts[0].id]){
  const p=seed();mutate(p);assert.throws(()=>validateQaSeed(p));
 }
 assert.doesNotThrow(()=>validateQaSeed(seed()));
});
test('wrong target or existing identity causes rollback before any insert',async()=>{
 for(const mode of ['target','conflict']){
  const calls=[];const c={async query(sql){calls.push(sql);if(sql.startsWith('SELECT current_database'))return {rows:[{database:mode==='target'?'kalend':'kalend_dev'}]};return {rows:[{n:mode==='conflict'?1:0}]};}};
  await assert.rejects(provisionQaIdentities(c,seed()));assert.equal(calls.at(-1),'ROLLBACK');assert.equal(calls.filter(x=>x.startsWith('INSERT')).length,0);
 }
});
test('insertion failure rolls the whole fixture back and never updates existing rows',async()=>{
 const calls=[];const c={async query(sql){calls.push(sql);if(sql.startsWith('SELECT current_database'))return {rows:[{database:'kalend_dev'}]};if(sql.startsWith('INSERT'))throw Error('fixture failure');return {rows:[{n:0}]};}};
 await assert.rejects(provisionQaIdentities(c,seed()));assert.equal(calls.at(-1),'ROLLBACK');assert.ok(calls.every(x=>!/^UPDATE|DELETE|ALTER|DROP/.test(x)));
});
