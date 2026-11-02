import { nativeTarget } from './support/native-postgres.js';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { BookingsService } from '../src/bookings/bookings.service.js';
import { EntitlementsService } from '../src/billing/entitlements.service.js';
import { OperationsService, type Operator } from '../src/operations/operations.service.js';
const { connectionString, directory } = nativeTarget();
const pool = new Pool({ connectionString, max: 6 });
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 6 }) });
const ops = new OperationsService(db as never, new EntitlementsService(db as never));
const bookings = new BookingsService(db as never, new EntitlementsService(db as never));
let a: Awaited<ReturnType<typeof company>>, b: Awaited<ReturnType<typeof company>>;
let startsAt: Date;
async function company() {
  const tenant = await db.company.create({ data: { name: 'Booking QA', slug: randomUUID() } });
  const plan = await db.plan.create({ data: { name: 'QA', code: randomUUID(), monthlyPriceCents: 100 } });
  await db.subscription.create({ data: { companyId: tenant.id, planId: plan.id, gateway: 'MANUAL', environment: 'SANDBOX', status: 'TRIALING', trialEndsAt: new Date(Date.now() + 30 * 86400000) } });
  const profiles = [];
  const members = [];
  for (const role of ['OWNER', 'PROFESSIONAL', 'PROFESSIONAL'] as const) {
    const user = await db.user.create({ data: { name: 'QA', email: `${randomUUID()}@example.test`, passwordHash: 'unused' } });
    const member = await db.membership.create({ data: { companyId: tenant.id, userId: user.id, role } });
    members.push(member);
    if (role === 'PROFESSIONAL') profiles.push(await db.professionalProfile.create({ data: { companyId: tenant.id, membershipId: member.id, displayName: `QA ${profiles.length}`, availability: { create: Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 0, endMinute: 1440 })) } } }));
  }
  const service = await db.service.create({ data: { companyId: tenant.id, name: 'QA service', durationMinutes: 30, priceCents: 5000, professionalLinks: { create: profiles.map(p => ({ professionalId: p.id })) } } });
  return { ...tenant, service, profiles, members };
}
function payload(tenant = a, professional = tenant.profiles[0], offset = 0) {
  return { idempotencyKey: randomUUID(), termsAccepted: true, customer: { name: 'QA Customer', email: `${randomUUID()}@example.test`, phone: `+5511${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}` }, items: [{ serviceId: tenant.service.id, professionalId: professional.id, startsAt: new Date(startsAt.getTime() + offset * 60000).toISOString() }] };
}
beforeAll(async () => {
  const result = await pool.query('SHOW data_directory');
  if (result.rows[0].data_directory !== directory) throw Error('WRONG_CLUSTER');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  for (const name of (await readdir('prisma/migrations')).sort()) if (name !== 'migration_lock.toml') await pool.query(await readFile(`prisma/migrations/${name}/migration.sql`, 'utf8'));
}, 120000);
beforeEach(async () => {
  await pool.query('TRUNCATE "Company", "User", "Plan" CASCADE');
  startsAt = new Date(Date.now() + 7 * 86400000); startsAt.setUTCHours(15, 0, 0, 0);
  a = await company(); b = await company();
});
afterAll(async () => { await db.$disconnect(); await pool.end(); });


function actor(tenant = a, index = 0): Operator { const m = tenant.members[index]; return { companyId: tenant.id, userId: m.userId, membershipId: m.id, role: m.role }; }
async function open(tenant = a) {
 const input = payload(tenant); const request = await bookings.request(tenant.slug, input); await bookings.decide(tenant.id, request.id, 'CONFIRMED');
 return ops.openSale(actor(tenant), { bookingRequestId: request.id, idempotencyKey: randomUUID() });
}
async function completed(sale: Awaited<ReturnType<typeof open>>) { for (const line of sale.lines) { await ops.lineAction(actor(), line.id, 'start'); await ops.lineAction(actor(), line.id, 'complete'); } }
const payment = (amountCents = 5000, method = 'CASH') => ({ idempotencyKey: randomUUID(), amountCents, method, confirmed: true, ...(method !== 'CASH' ? { reference: 'QA settlement' } : {}) });
it('copies confirmed appointment snapshots and finalizes only performed and fully paid services', async () => {
 const sale = await open(); expect(sale.status).toBe('OPEN'); expect(sale.totalCents).toBe(5000);
 await expect(ops.finalize(actor(), sale.id)).rejects.toThrow('Conclua');
 await completed(sale); await expect(ops.finalize(actor(), sale.id)).rejects.toThrow('saldo');
 await expect(ops.receive(actor(), sale.id, payment())).rejects.toThrow('Abra o caixa');
 await ops.cashOpen(actor(), { openingCents: 1000 }); await ops.receive(actor(), sale.id, payment());
 expect((await ops.finalize(actor(), sale.id)).status).toBe('PAID');
 expect((await ops.finalize(actor(), sale.id)).status).toBe('PAID');
 expect(await db.payment.count()).toBe(0); expect(await db.posReceipt.count()).toBe(1);
});
it('enforces tenant and professional scope and hides colleagues financial data', async () => {
 const sale = await open(); await expect(ops.addLine(actor(b), sale.id, { productId: randomUUID() })).rejects.toThrow('não encontrada');
 await expect(ops.lineAction(actor(a,2), sale.lines[0].id, 'start')).rejects.toThrow('outro profissional');
 await ops.lineAction(actor(a,1), sale.lines[0].id, 'start');
 await expect(ops.receive(actor(a,1), sale.id, payment())).rejects.toThrow('não autorizada');
 const board = await ops.board(actor(a,1)); expect(board.sales).toHaveLength(1); expect(board.sales[0]).not.toHaveProperty('payments'); expect(board.sales[0]).not.toHaveProperty('totalCents');
 expect((await ops.board(actor(b))).sales).toHaveLength(0);
});
it('keeps one cash session open under a concurrent race', async () => {
 const r = await Promise.allSettled([ops.cashOpen(actor(), {openingCents:100}),ops.cashOpen(actor(), {openingCents:100})]);
 expect(r.filter(x=>x.status==='fulfilled')).toHaveLength(1); expect(await db.posCashSession.count({where:{closedAt:null}})).toBe(1);
});
it('deduplicates concurrent receipts and refuses key reuse with different amounts', async () => {
 const sale=await open(); await ops.cashOpen(actor(),{openingCents:0});const p=payment();
 const r=await Promise.all([ops.receive(actor(),sale.id,p),ops.receive(actor(),sale.id,p)]);expect(r[0].id).toBe(r[1].id);
 await expect(ops.receive(actor(),sale.id,{...p,amountCents:1})).rejects.toThrow('Chave');expect(await db.posReceipt.count()).toBe(1);
});
it('prevents two different concurrent receipts from overpaying a sale', async () => {
 const sale=await open();await ops.cashOpen(actor(),{openingCents:0});const r=await Promise.allSettled([ops.receive(actor(),sale.id,payment()),ops.receive(actor(),sale.id,payment())]);expect(r.filter(x=>x.status==='fulfilled')).toHaveLength(1);
});
it('reconciles split methods and only cash affects the counted drawer', async () => {
 const sale=await open(),cash=await ops.cashOpen(actor(),{openingCents:1000});await completed(sale);
 await ops.receive(actor(),sale.id,payment(2000,'PIX'));await ops.receive(actor(),sale.id,payment(3000));await ops.finalize(actor(),sale.id);
 const close=await ops.cashClose(actor(),cash.id,{countedCents:4000});expect(close.expectedCents).toBe(4000);expect(close.differenceCents).toBe(0);
 await expect(ops.cashClose(actor(),cash.id,{countedCents:0})).rejects.toThrow('fechado');
});
it('records products and discounts without trusting browser prices and preserves snapshots', async () => {
 const sale=await open(),product=await ops.createProduct(actor(),{name:'QA product',priceCents:1000});
 await ops.addLine(actor(),sale.id,{productId:product.id,quantity:2});const updated=await ops.discount(actor(),sale.id,{amountCents:1000,reason:'QA authorized'});expect(updated.totalCents).toBe(6000);
 await db.service.update({where:{id:a.service.id},data:{priceCents:9000}});expect(updated.lines[0].unitPriceCents).toBe(5000);
 await expect(ops.addLine(actor(),sale.id,{productId:product.id,unitPriceCents:1})).rejects.toThrow('Campo não permitido');
 const foreign=await ops.createProduct(actor(b),{name:'foreign',priceCents:100});await expect(ops.addLine(actor(),sale.id,{productId:foreign.id})).rejects.toThrow('indisponível');
});
it('reserves coupon usage atomically, releases cancellation, and refuses unauthorized discounts', async () => {
 await ops.createCoupon(actor(),{code:'QA10',percentBps:1000,maxUses:1});const sale=await open(),other=await ops.openSale(actor(),{idempotencyKey:randomUUID()});
 await ops.addLine(actor(),other.id,{serviceId:a.service.id,professionalId:a.profiles[0].id});
 const receiver=await db.user.create({data:{name:'Reception QA',email:randomUUID()+'@example.test',passwordHash:'unused'}}),member=await db.membership.create({data:{companyId:a.id,userId:receiver.id,role:'RECEPTIONIST'}}),reception={companyId:a.id,userId:receiver.id,membershipId:member.id,role:'RECEPTIONIST'};
 await expect(ops.discount(reception,sale.id,{amountCents:1,reason:'unauthorized'})).rejects.toThrow('não autorizada');
 expect((await ops.coupon(reception,sale.id,{code:'QA10'})).discountCents).toBe(500);
 await expect(ops.coupon(actor(),other.id,{code:'QA10'})).rejects.toThrow('Limite');await ops.cancel(actor(),sale.id,{reason:'QA'});await expect(ops.coupon(actor(),other.id,{code:'QA10'})).resolves.toHaveProperty('discountCents',500);
});
it('prevents excessive concurrent refunds and keeps immutable receipts and audit', async () => {
 const sale=await open();await completed(sale);await ops.cashOpen(actor(),{openingCents:0});const receipt=await ops.receive(actor(),sale.id,payment());await ops.finalize(actor(),sale.id);
 const refund=()=>({idempotencyKey:randomUUID(),amountCents:4000,reason:'QA refund',confirmed:true});const r=await Promise.allSettled([ops.refund(actor(),receipt.id,refund()),ops.refund(actor(),receipt.id,refund())]);expect(r.filter(x=>x.status==='fulfilled')).toHaveLength(1);
 expect((await ops.board(actor())).sales[0].status).toBe('PARTIALLY_REFUNDED');
 await expect(db.posReceipt.update({where:{id:receipt.id},data:{amountCents:1}})).rejects.toThrow();await expect(db.posAudit.deleteMany()).rejects.toThrow();
 await ops.refund(actor(),receipt.id,{...refund(),amountCents:1000});expect((await ops.board(actor())).sales[0].status).toBe('REFUNDED');
});
it('records refunds in the current drawer rather than changing a previously closed session', async () => {
 const sale=await open();await completed(sale);const cash=await ops.cashOpen(actor(),{openingCents:0}),receipt=await ops.receive(actor(),sale.id,payment());await ops.finalize(actor(),sale.id);await ops.cashClose(actor(),cash.id,{countedCents:5000});
 const next=await ops.cashOpen(actor(),{openingCents:5000});await ops.refund(actor(),receipt.id,{idempotencyKey:randomUUID(),amountCents:5000,reason:'QA return',confirmed:true});const closed=await ops.cashClose(actor(),next.id,{countedCents:0});expect(closed.expectedCents).toBe(0);expect((await db.posCashSession.findUniqueOrThrow({where:{id:cash.id}})).expectedCents).toBe(5000);
});
it('rejects cross-tenant composite sale references at database level', async () => {
 const sale=await open(),foreign=await ops.createProduct(actor(b),{name:'foreign',priceCents:100});await expect(db.posSaleLine.create({data:{companyId:a.id,saleId:sale.id,productId:foreign.id,name:'bad',unitPriceCents:1}})).rejects.toThrow();
});
it('deduplicates concurrent opening of the same confirmed appointment', async () => {
 const request=await bookings.request(a.slug,payload());await bookings.decide(a.id,request.id,'CONFIRMED');const data={bookingRequestId:request.id,idempotencyKey:randomUUID()};const rows=await Promise.all([ops.openSale(actor(),data),ops.openSale(actor(),data)]);expect(rows[0].id).toBe(rows[1].id);expect(await db.posSaleLine.count()).toBe(1);
});

it('requires a funded current drawer for cash refunds after the original drawer closes', async () => {
 const sale=await open(),cash=await ops.cashOpen(actor(),{openingCents:0}),receipt=await ops.receive(actor(),sale.id,payment());await ops.cashClose(actor(),cash.id,{countedCents:5000});await ops.cashOpen(actor(),{openingCents:0});await expect(ops.refund(actor(),receipt.id,{idempotencyKey:randomUUID(),amountCents:1,reason:'QA',confirmed:true})).rejects.toThrow('Saldo em dinheiro');expect(await db.posRefund.count()).toBe(0);
});
it('serializes cash closure against a receipt so a closed drawer never gains a late entry', async () => {
 const sale=await open(),cash=await ops.cashOpen(actor(),{openingCents:0});
 await Promise.allSettled([ops.receive(actor(),sale.id,payment()),ops.cashClose(actor(),cash.id,{countedCents:0,note:'QA reconciliation'})]);
 const closed=await db.posCashSession.findUniqueOrThrow({where:{id:cash.id}}),receipts=await db.posReceipt.findMany({where:{cashSessionId:cash.id}});expect(closed.expectedCents).toBe(receipts.reduce((n,p)=>n+p.amountCents,0));
});
import { CommissionsService } from '../src/operations/commissions.service.js';
const commissions = new CommissionsService(db as never, ops);
async function commissionSale() { await commissions.rules(actor(),{professionalId:a.profiles[0].id,serviceId:a.service.id,percentBps:2000});const sale=await open();await completed(sale);await ops.cashOpen(actor(),{openingCents:0});await ops.receive(actor(),sale.id,payment());return sale; }
it('previews commissions then generates once only after completed full settlement', async()=>{
 const sale=await commissionSale();expect((await commissions.list(actor(a,1))).preview[0].amountCents).toBe(1000);expect(await db.posCommission.count()).toBe(0);await ops.finalize(actor(),sale.id);await ops.finalize(actor(),sale.id);const list=await commissions.list(actor(a,1));expect(list.commissions).toHaveLength(1);expect(list.commissions[0].status).toBe('GENERATED');expect(list.commissions[0].amountCents).toBe(1000);expect((await commissions.list(actor(a,2))).commissions).toHaveLength(0);
});
it('freezes commission rule snapshots, supports release and partial payouts without overpayment',async()=>{
 const sale=await commissionSale();await ops.finalize(actor(),sale.id);const c=(await commissions.list(actor())).commissions[0];await commissions.rules(actor(),{professionalId:a.profiles[0].id,serviceId:a.service.id,fixedCents:5});expect((await commissions.list(actor())).commissions[0].amountCents).toBe(1000);await expect(commissions.pay(actor(),c.id,{idempotencyKey:randomUUID(),amountCents:1,method:'TRANSFER',reference:'QA',confirmed:true})).rejects.toThrow('não liberada');await commissions.release(actor(),c.id);const body={idempotencyKey:randomUUID(),amountCents:600,method:'TRANSFER',reference:'QA split',confirmed:true};const r=await Promise.all([commissions.pay(actor(),c.id,body),commissions.pay(actor(),c.id,body)]);expect(r[0].id).toBe(r[1].id);await commissions.pay(actor(),c.id,{...body,idempotencyKey:randomUUID(),amountCents:400});await expect(commissions.pay(actor(),c.id,{...body,idempotencyKey:randomUUID(),amountCents:1})).rejects.toThrow();expect((await commissions.list(actor())).commissions[0].status).toBe('PAID');
});
it('refunds reduce commissions proportionally and expose recovery without erasing paid history',async()=>{
 const sale=await commissionSale();await ops.finalize(actor(),sale.id);const c=(await commissions.list(actor())).commissions[0];await commissions.release(actor(),c.id);await commissions.pay(actor(),c.id,{idempotencyKey:randomUUID(),amountCents:1000,method:'TRANSFER',reference:'QA',confirmed:true});const receipt=await db.posReceipt.findFirstOrThrow({where:{saleId:sale.id}});await ops.refund(actor(),receipt.id,{idempotencyKey:randomUUID(),amountCents:2500,reason:'QA partial',confirmed:true});const after=(await commissions.list(actor(a,1))).commissions[0];expect(after.amountCents).toBe(500);expect(after.paidCents).toBe(1000);expect(after.recoveryCents).toBe(500);expect(after.adjustments).toHaveLength(1);
});
it('cash commission payout affects cash reconciliation and requires current funds',async()=>{
 const sale=await commissionSale();await ops.finalize(actor(),sale.id);const c=(await commissions.list(actor())).commissions[0];await commissions.release(actor(),c.id);await commissions.pay(actor(),c.id,{idempotencyKey:randomUUID(),amountCents:1000,method:'CASH',reference:'QA cash',confirmed:true});const cash=await db.posCashSession.findFirstOrThrow({where:{closedAt:null}});expect((await ops.cashClose(actor(),cash.id,{countedCents:4000})).expectedCents).toBe(4000);
});
it('rejects cross-tenant commission rules and payouts and audits authorized adjustments',async()=>{
 await expect(commissions.rules(actor(),{professionalId:b.profiles[0].id,serviceId:a.service.id,percentBps:1000})).rejects.toThrow();const sale=await commissionSale();await ops.finalize(actor(),sale.id);const c=(await commissions.list(actor())).commissions[0],body={idempotencyKey:randomUUID(),deltaCents:-100,reason:'QA adjustment'};await expect(commissions.adjust(actor(b),c.id,body)).rejects.toThrow('não encontrada');await expect(commissions.adjust(actor(a,1),c.id,body)).rejects.toThrow('não autorizada');await commissions.adjust(actor(),c.id,body);await commissions.adjust(actor(),c.id,body);expect((await commissions.list(actor())).commissions[0].amountCents).toBe(900);await expect(commissions.adjust(actor(),c.id,{...body,deltaCents:-200})).rejects.toThrow('Chave');
});
it('commission reversals use net settlement, ignoring pre-final refunds that were repaid',async()=>{
 const sale=await commissionSale(),receipt=await db.posReceipt.findFirstOrThrow({where:{saleId:sale.id}});await ops.refund(actor(),receipt.id,{idempotencyKey:randomUUID(),amountCents:1000,reason:'QA before close',confirmed:true});await ops.receive(actor(),sale.id,payment(1000));await ops.finalize(actor(),sale.id);await ops.refund(actor(),receipt.id,{idempotencyKey:randomUUID(),amountCents:1000,reason:'QA after close',confirmed:true});expect((await commissions.list(actor())).commissions[0].amountCents).toBe(800);
});
