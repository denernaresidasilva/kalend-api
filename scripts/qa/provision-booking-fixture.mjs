// DEV-only fixture: inserts new QA companies and memberships, never edits existing identities.
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
const input = JSON.parse(readFileSync(process.env.QA_BOOKING_INPUT, 'utf8'));
if (!input.planId || !input.ownerA || !input.ownerB || !input.professional) throw Error('QA_INPUT_REQUIRED');
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
try {
 const target = await db.$queryRaw`SELECT current_database() AS database, current_user AS role`;
 if(target[0].database !== 'kalend_dev' || target[0].role !== 'kalend_dev_runtime') throw Error('DEV_RUNTIME_REQUIRED');
 const result = await db.$transaction(async tx => {
  const plan = await tx.plan.findUniqueOrThrow({where:{id:input.planId}});
  if(plan.isPublic) throw Error('PRIVATE_QA_PLAN_REQUIRED');
  for(const id of [input.ownerA,input.ownerB,input.professional]) {
   const user = await tx.user.findUniqueOrThrow({where:{id}});
   if(!/^qa\+[^@]+@qa\.kalend\.invalid$/.test(user.email)||user.isSuperAdmin||!user.isActive) throw Error('EXISTING_QA_IDENTITY_REQUIRED');
  }
  const companies=[];
  for(const [label,ownerId] of [['A',input.ownerA],['B',input.ownerB]]) {
   const slug=`qa-booking-${randomUUID()}`;
   const company=await tx.company.create({data:{name:`QA Booking ${label}`,slug,status:'TRIAL'}});
   const owner=await tx.membership.create({data:{companyId:company.id,userId:ownerId,role:'OWNER'}});
   const professional=label==='A'?await tx.membership.create({data:{companyId:company.id,userId:input.professional,role:'PROFESSIONAL'}}):null;
   await tx.subscription.create({data:{companyId:company.id,planId:plan.id,status:'TRIALING',gateway:'MANUAL',environment:'SANDBOX',trialEndsAt:new Date(Date.now()+30*86400000)}});
   companies.push({label,id:company.id,slug,ownerMembershipId:owner.id,professionalMembershipId:professional?.id});
  }
  return {database:'kalend_dev',createdAt:new Date().toISOString(),companies};
 });
 console.log(JSON.stringify(result));
} finally {await db.$disconnect();}
