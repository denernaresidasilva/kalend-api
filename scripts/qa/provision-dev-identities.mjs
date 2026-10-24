/** Operator-only fixture insertion. Never imported at application startup. */
import { randomUUID } from 'node:crypto';
export function validateQaSeed(plan) {
  if (plan.database !== 'kalend_dev' || plan.provisioned !== false || !/^QA-E2E-SA-[0-9a-f]{16}$/.test(plan.runId)) throw new Error('INVALID_QA_PLAN');
  const nonce=plan.runId.slice('QA-E2E-SA-'.length);
  const roles=['SUPER_ADMIN','OWNER_A','OWNER_B','PROFESSIONAL_A','DISABLED_A'];
  if (plan.accounts.length!==5 || plan.companies.length!==2 || new Set(plan.accounts.map(a=>a.role)).size!==5) throw new Error('INVALID_QA_IDENTITIES');
  for (const role of roles) {
    const a=plan.accounts.find(a=>a.role===role);
    if (!a || a.email!==`qa+${role.toLowerCase()}-${nonce}@qa.kalend.invalid` || a.name!==`${plan.runId}-${role}` || a.passwordHash?.slice(0,7)!=='$2b$12$') throw new Error('INVALID_QA_IDENTITY');
  }
  for (const label of ['A','B']) {
    const c=plan.companies.find(c=>c.label===label);
    if (!c || c.name!==`${plan.runId}-${label}` || c.slug!==`qa-e2e-sa-${nonce}-${label.toLowerCase()}`) throw new Error('INVALID_QA_TENANT');
  }
  const ids=[...plan.accounts,...plan.companies].map(x=>x.id);
  if (new Set(ids).size!==7 || ids.some(x=>!/^[0-9a-f-]{36}$/.test(x))) throw new Error('INVALID_QA_IDS');
}

export async function provisionQaIdentities(client, plan) {
  validateQaSeed(plan);
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  try {
    const target=await client.query('SELECT current_database() AS database');
    if (target.rows[0].database!=='kalend_dev') throw new Error('WRONG_DATABASE');
    await client.query('SELECT pg_advisory_xact_lock(18473, 92027)');
    const conflicts=await client.query('SELECT (SELECT count(*) FROM "User" WHERE id=ANY($1::uuid[]) OR email=ANY($2::text[]))+(SELECT count(*) FROM "Company" WHERE id=ANY($3::uuid[]) OR slug=ANY($4::text[])) AS n',[plan.accounts.map(a=>a.id),plan.accounts.map(a=>a.email),plan.companies.map(c=>c.id),plan.companies.map(c=>c.slug)]);
    if (Number(conflicts.rows[0].n)!==0) throw new Error('QA_COLLISION_ABORT');
    const planId=randomUUID();
    await client.query('INSERT INTO "Plan" (id,name,code,"monthlyPriceCents","trialEnabled","trialDays","isActive","isPublic","updatedAt") VALUES ($1,$2,$3,1000,true,7,true,false,now())',[planId,plan.runId,plan.runId.toLowerCase()]);
    for (const c of plan.companies) await client.query('INSERT INTO "Company" (id,name,slug,status,"updatedAt") VALUES ($1,$2,$3,\'TRIAL\',now())',[c.id,c.name,c.slug]);
    for (const a of plan.accounts) {
      await client.query('INSERT INTO "User" (id,email,name,"passwordHash","isActive","isSuperAdmin","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,now())',[a.id,a.email,a.name,a.passwordHash,a.role!=='DISABLED_A',a.role==='SUPER_ADMIN']);
      if (a.role!=='SUPER_ADMIN') {
        const company=plan.companies.find(c=>c.label===(a.role==='OWNER_B'?'B':'A'));
        await client.query('INSERT INTO "Membership" (id,"userId","companyId",role,"updatedAt") VALUES ($1,$2,$3,$4,now())',[randomUUID(),a.id,company.id,a.role.startsWith('OWNER')?'OWNER':'PROFESSIONAL']);
      }
    }
    const subscriptions=[];
    for (const c of plan.companies) {
      const id=randomUUID();
      await client.query('INSERT INTO "Subscription" (id,"companyId","planId",status,gateway,environment,"trialStartedAt","trialEndsAt","updatedAt") VALUES ($1,$2,$3,\'TRIALING\',\'QA_SIMULATION\',\'SANDBOX\',now(),now()+interval \'7 days\',now())',[id,c.id,planId]);
      subscriptions.push({companyId:c.id,id});
    }
    const verified=await client.query('SELECT count(*)::int AS n FROM "User" WHERE id=ANY($1::uuid[])',[plan.accounts.map(a=>a.id)]);
    if (verified.rows[0].n!==5) throw new Error('QA_INSERT_INCOMPLETE');
    await client.query('COMMIT');
    return { createdUsers:5,createdCompanies:2,createdMemberships:4,createdPlans:1,createdTrials:2,planId,subscriptions,paymentRowsCreated:0,paidEntitlementsCreated:0,existingRowsUpdated:0 };
  } catch(error) { await client.query('ROLLBACK'); throw error; }
}
