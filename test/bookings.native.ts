import { nativeTarget } from './support/native-postgres.js';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { BookingsService } from '../src/bookings/bookings.service.js';
import { EntitlementsService } from '../src/billing/entitlements.service.js';

const { connectionString, directory } = nativeTarget();
const pool = new Pool({ connectionString, max: 6 });
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 6 }) });
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
const date = () => startsAt.toISOString().slice(0, 10);
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

it('persists public request and notification, then adds confirmed items to the tenant agenda', async () => {
  const request = await bookings.request(a.slug, payload());
  expect((await bookings.agenda(a.id, 'OWNER', a.members[0].id, date())).items).toHaveLength(0);
  expect(await db.notification.count({ where: { companyId: a.id, sourceKey: `booking-request:${request.id}` } })).toBe(1);
  await bookings.decide(a.id, request.id, 'CONFIRMED');
  expect((await bookings.agenda(a.id, 'OWNER', a.members[0].id, date())).items).toHaveLength(1);
  expect((await bookings.agenda(b.id, 'OWNER', b.members[0].id, date())).items).toHaveLength(0);
});
it('filters shared request items and customer contact from the professional inbox and agenda', async () => {
  const input = payload(); input.items.push(payload(a, a.profiles[1], 60).items[0]);
  const request = await bookings.request(a.slug, input);
  const inbox = await bookings.listRequests(a.id, 'PROFESSIONAL', a.profiles[0].membershipId);
  expect(inbox[0].items).toHaveLength(1);
  expect(Object.keys(inbox[0].customer)).toEqual(['name']);
  await bookings.decide(a.id, request.id, 'CONFIRMED');
  expect((await bookings.agenda(a.id, 'PROFESSIONAL', a.profiles[0].membershipId, date())).items).toHaveLength(1);
  expect((await bookings.agenda(a.id, 'PROFESSIONAL', b.profiles[0].membershipId, date())).items).toHaveLength(0);
});
it('rejects cross-company service, professional, decision and composite FK', async () => {
  const input = payload(); input.items[0].serviceId = b.service.id;
  await expect(bookings.request(a.slug, input)).rejects.toThrow('não está disponível');
  const request = await bookings.request(a.slug, payload());
  await expect(bookings.decide(b.id, request.id, 'CONFIRMED')).rejects.toThrow('não encontrada');
  await expect(db.serviceProfessional.create({ data: { companyId: a.id, serviceId: a.service.id, professionalId: b.profiles[0].id } })).rejects.toThrow();
});
it('allows only one of two concurrent requests for the same professional slot', async () => {
  const result = await Promise.allSettled([bookings.request(a.slug, payload()), bookings.request(a.slug, payload())]);
  expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(await db.bookingRequest.count({ where: { companyId: a.id } })).toBe(1);
});
it('returns one request and one notification for concurrent idempotent retries', async () => {
  const input = payload();
  const result = await Promise.all([bookings.request(a.slug, input), bookings.request(a.slug, input)]);
  expect(result[0].id).toBe(result[1].id);
  expect(await db.bookingRequest.count()).toBe(1);
  expect(await db.notification.count()).toBe(1);
});
it('processes one decision when acceptance and rejection race', async () => {
  const request = await bookings.request(a.slug, payload());
  const result = await Promise.allSettled([bookings.decide(a.id, request.id, 'CONFIRMED'), bookings.decide(a.id, request.id, 'REJECTED')]);
  expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  const state = await db.bookingRequest.findUniqueOrThrow({ where: { id: request.id } });
  expect((await bookings.agenda(a.id, 'OWNER', a.members[0].id, date())).items).toHaveLength(state.status === 'CONFIRMED' ? 1 : 0);
});
it('revalidates expired holds against a newer reservation', async () => {
  const first = await bookings.request(a.slug, payload());
  await db.bookingRequest.update({ where: { id: first.id }, data: { holdExpiresAt: new Date(0) } });
  const second = await bookings.request(a.slug, payload());
  await expect(bookings.decide(a.id, first.id, 'CONFIRMED')).rejects.toThrow('indisponível');
  await bookings.decide(a.id, second.id, 'CONFIRMED');
});
it('refuses acceptance after professional deactivation', async () => {
  const request = await bookings.request(a.slug, payload());
  await db.professionalProfile.update({ where: { id: a.profiles[0].id }, data: { active: false } });
  await expect(bookings.decide(a.id, request.id, 'CONFIRMED')).rejects.toThrow('não está mais disponível');
});
it('refuses acceptance when availability was removed', async () => {
  const request = await bookings.request(a.slug, payload());
  await db.professionalAvailability.deleteMany({ where: { professionalId: a.profiles[0].id } });
  await expect(bookings.decide(a.id, request.id, 'CONFIRMED')).rejects.toThrow('fora da disponibilidade');
});
it('refuses past items without changing a pending request', async () => {
  const request = await bookings.request(a.slug, payload());
  await db.bookingRequestItem.updateMany({ where: { requestId: request.id }, data: { startsAt: new Date(Date.now() - 3600000), endsAt: new Date(Date.now() - 1800000) } });
  await expect(bookings.decide(a.id, request.id, 'CONFIRMED')).rejects.toThrow('horário passado');
  expect((await db.bookingRequest.findUniqueOrThrow({ where: { id: request.id } })).status).toBe('REQUESTED');
});
it('rejection frees the slot and never adds items to the agenda', async () => {
  const request = await bookings.request(a.slug, payload());
  await bookings.decide(a.id, request.id, 'REJECTED');
  expect((await bookings.agenda(a.id, 'OWNER', a.members[0].id, date())).items).toHaveLength(0);
  await expect(bookings.request(a.slug, payload())).resolves.toHaveProperty('status', 'REQUESTED');
});
it('configures the first service and composite relations atomically', async () => {
  const result = await bookings.setupFirstService(b.id, {
    service: { name: 'New QA service', durationMinutes: 30, priceCents: 2000 },
    professional: { membershipId: b.members[0].id, displayName: 'Owner QA' },
    availability: [{ weekday: 1, startMinute: 540, endMinute: 1020 }],
  });
  expect(result.professional.availability).toHaveLength(1);
  expect(result.professional.services[0].serviceId).toBe(result.service.id);
  const published = (await bookings.catalog(b.slug)).services.find(s => s.id === result.service.id);
  expect(published?.professionals[0].name).toBe('Owner QA');
});
it('allows only one expired competing reservation to be confirmed concurrently', async () => {
  const first = await bookings.request(a.slug, payload());
  await db.bookingRequest.update({ where: { id: first.id }, data: { holdExpiresAt: new Date(0) } });
  const second = await bookings.request(a.slug, payload());
  await db.bookingRequest.update({ where: { id: second.id }, data: { holdExpiresAt: new Date(0) } });
  const result = await Promise.allSettled([bookings.decide(a.id, first.id, 'CONFIRMED'), bookings.decide(a.id, second.id, 'CONFIRMED')]);
  expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect((await bookings.agenda(a.id, 'OWNER', a.members[0].id, date())).items).toHaveLength(1);
});
it('publishes database notifications for committed requests and decisions without customer data', async () => {
  const listener = await pool.connect();
  await listener.query('LISTEN kalend_booking_events');
  const nextEvent = () => new Promise<{ companyId: string; professionalIds: string[] }>((resolve, reject) => {
    const timeout = setTimeout(() => { listener.off('notification', receive); reject(new Error('BOOKING_EVENT_TIMEOUT')); }, 3000);
    const receive = (event: { payload?: string }) => { clearTimeout(timeout); resolve(JSON.parse(event.payload!)); };
    listener.once('notification', receive);
  });
  try {
    const requested = nextEvent();
    const booking = await bookings.request(a.slug, payload());
    const event = await requested;
    expect(event).toEqual({ companyId: a.id, professionalIds: [a.profiles[0].id] });
    const decided = nextEvent(); await bookings.decide(a.id, booking.id, 'CONFIRMED');
    expect(await decided).toEqual(event);
  } finally { await listener.query('UNLISTEN kalend_booking_events'); listener.release(); }
});

// Client activation reuses the same real, disposable PostgreSQL fixture.
import { CustomerAccessService } from '../src/bookings/customer-access.service.js';
import * as bcrypt from 'bcrypt';
import { createHash } from 'node:crypto';
const clients = new CustomerAccessService(db as never, new EntitlementsService(db as never));
const qaPassword = 'QA-only-password-2026!';
async function activationFixture() {
  const input = payload(); const booking = await bookings.request(a.slug, input);
  const customer = await db.customerProfile.findFirstOrThrow({ where: { companyId: a.id, email: input.customer.email } });
  const invite = await clients.issue(a.id, customer.id, a.members[0].userId);
  const body = { token: invite.token, email: input.customer.email, password: qaPassword, termsAccepted: true };
  return { input, booking, customer, invite, body };
}
it('stores only a token hash and activates a tenant-only client with consent', async () => {
  const { customer, invite, body } = await activationFixture();
  const row = await db.customerActivation.findFirstOrThrow({ where: { customerId: customer.id } });
  expect(row.tokenHash).toBe(createHash('sha256').update(invite.token).digest('hex'));
  expect(JSON.stringify(row)).not.toContain(invite.token);
  await expect(clients.activate(body)).resolves.toEqual({ activated: true });
  const user = await db.user.findUniqueOrThrow({ where: { email: body.email }, include: { memberships: true } });
  expect(user.isSuperAdmin).toBe(false); expect(user.memberships.map(m => [m.companyId, m.role])).toEqual([[a.id, 'CLIENT']]);
  expect(await bcrypt.compare(qaPassword, user.passwordHash)).toBe(true);
  expect(await db.publicSignupConsent.count({ where: { userId: user.id, companyId: a.id, source: 'CUSTOMER_ACTIVATION' } })).toBe(1);
});
it('rejects foreign invitations and client data reads never cross user or tenant', async () => {
  const { customer, body, booking } = await activationFixture();
  await expect(clients.issue(b.id, customer.id, b.members[0].userId)).rejects.toThrow('não encontrado');
  await clients.activate(body);
  const user = await db.user.findUniqueOrThrow({ where: { email: body.email } });
  expect((await clients.mine(a.id, user.id)).requests.map(r => r.id)).toEqual([booking.id]);
  expect((await clients.mine(b.id, user.id)).requests).toHaveLength(0);
  expect((await clients.mine(a.id, b.members[0].userId)).requests).toHaveLength(0);
});
it('blocks anonymous use of an activated client identity but allows its authenticated owner', async () => {
  const { input, body } = await activationFixture(); await clients.activate(body);
  const user = await db.user.findUniqueOrThrow({ where: { email: body.email } });
  input.idempotencyKey = randomUUID(); input.items[0].startsAt = new Date(startsAt.getTime() + 3600000).toISOString();
  await expect(bookings.request(a.slug, input)).rejects.toThrow('Entre na conta');
  await expect(bookings.request(a.slug, input, 0, b.members[0].userId)).rejects.toThrow('Entre na conta');
  await expect(bookings.request(a.slug, input, 0, user.id)).resolves.toHaveProperty('status', 'REQUESTED');
});
it('expires invitations, invalidates regenerated tokens and prevents replay', async () => {
  const { customer, body } = await activationFixture();
  await db.customerActivation.updateMany({ where: { customerId: customer.id }, data: { expiresAt: new Date(0) } });
  await expect(clients.activate(body)).rejects.toThrow('Não foi possível ativar');
  const replacement = await clients.issue(a.id, customer.id, a.members[0].userId);
  await expect(clients.activate(body)).rejects.toThrow('Não foi possível ativar');
  await clients.activate({ ...body, token: replacement.token });
  await expect(clients.activate({ ...body, token: replacement.token })).rejects.toThrow('Não foi possível ativar');
});
it('does not let invitation activation reset or take over an existing identity', async () => {
  const existing = await db.user.findUniqueOrThrow({ where: { id: b.members[0].userId } });
  const passwordHash = await bcrypt.hash(qaPassword, 4);
  await db.user.update({ where: { id: existing.id }, data: { passwordHash } });
  const input = payload(); input.customer.email = existing.email;
  await bookings.request(a.slug, input);
  const customer = await db.customerProfile.findFirstOrThrow({ where: { companyId: a.id, email: existing.email } });
  const invite = await clients.issue(a.id, customer.id, a.members[0].userId);
  const body = { token: invite.token, email: existing.email, termsAccepted: true };
  await expect(clients.activate({ ...body, password: 'WRONG-password!' })).rejects.toThrow('Não foi possível ativar');
  expect((await db.user.findUniqueOrThrow({ where: { id: existing.id } })).passwordHash).toBe(passwordHash);
  await clients.activate({ ...body, password: qaPassword });
  expect((await db.user.findUniqueOrThrow({ where: { id: existing.id } })).passwordHash).toBe(passwordHash);
  expect((await db.membership.findUniqueOrThrow({ where: { userId_companyId: { userId: existing.id, companyId: b.id } } })).role).toBe('OWNER');
});
it('consumes an invitation once under concurrent activation', async () => {
  const { body } = await activationFixture();
  const result = await Promise.allSettled([clients.activate(body), clients.activate(body)]);
  expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(await db.user.count({ where: { email: body.email } })).toBe(1);
});
it('requires account consent and rejects email substitution without consuming the capability', async () => {
  const { body, customer } = await activationFixture();
  await expect(clients.activate({ ...body, termsAccepted: false })).rejects.toThrow('Aceite os termos');
  await expect(clients.activate({ ...body, email: 'someone-else@example.test' })).rejects.toThrow('Não foi possível ativar');
  expect((await db.customerActivation.findFirstOrThrow({ where: { customerId: customer.id } })).usedAt).toBeNull();
});
it('creates a service and its own professional links atomically, rejecting foreign profiles', async () => {
  const count = await db.service.count({ where: { companyId: a.id } });
  await expect(bookings.createService(a.id, { name: 'Foreign', durationMinutes: 30, priceCents: 100, professionalIds: [b.profiles[0].id] })).rejects.toThrow('não disponíveis');
  expect(await db.service.count({ where: { companyId: a.id } })).toBe(count);
  const created = await bookings.createService(a.id, { name: 'New service', durationMinutes: 30, priceCents: 100, professionalIds: [a.profiles[0].id] });
  expect((await bookings.catalog(a.slug)).services.find(s => s.id === created.id)?.professionals[0].name).toBe('QA 0');
});
it('edits service values without changing existing booking snapshots', async () => {
  const request = await bookings.request(a.slug, payload());
  await bookings.updateService(a.id, a.service.id, { name: 'Updated', durationMinutes: 60, priceCents: 9000 });
  const stored = await db.bookingRequestItem.findFirstOrThrow({ where: { requestId: request.id } });
  expect(stored.serviceName).toBe('QA service'); expect(stored.durationMinutes).toBe(30); expect(stored.priceCents).toBe(5000);
  await expect(bookings.updateService(b.id, a.service.id, { active: false })).rejects.toThrow('não encontrado');
  await expect(bookings.updateProfessional(b.id, a.profiles[0].id, { active: false })).rejects.toThrow('não encontrado');
});
it('enforces the plan limit on professional creation and reactivation', async () => {
  const sub = await db.subscription.findFirstOrThrow({ where: { companyId: a.id } });
  await db.plan.update({ where: { id: sub.planId }, data: { maxProfessionals: 0 } });
  await expect(bookings.createProfessional(a.id, { membershipId: a.members[0].id, displayName: 'Limit QA' })).rejects.toThrow();
  await bookings.updateProfessional(a.id, a.profiles[0].id, { active: false });
  await expect(bookings.updateProfessional(a.id, a.profiles[0].id, { active: true })).rejects.toThrow();
  expect((await db.professionalProfile.findUniqueOrThrow({ where: { id: a.profiles[0].id } })).active).toBe(false);
});
it('rejects all service changes atomically if a linked professional is from another company', async () => {
  await expect(bookings.updateService(a.id, a.service.id, { priceCents: 9000, professionalIds: [b.profiles[0].id] })).rejects.toThrow('não disponíveis');
  expect((await db.service.findUniqueOrThrow({ where: { id: a.service.id } })).priceCents).toBe(5000);
});
it('removes stale professional-role memberships from the public catalog', async () => {
  await db.membership.updateMany({ where: { id: { in: a.profiles.map(p => p.membershipId) } }, data: { role: 'CLIENT' } });
  expect((await bookings.catalog(a.slug)).services).toHaveLength(0);
});
it('rejects duplicate professional registration without changing existing profiles', async () => {
  const count = await db.professionalProfile.count({ where: { companyId: a.id } });
  await expect(bookings.createProfessional(a.id, { membershipId: a.profiles[0].membershipId, displayName: 'Duplicate' })).rejects.toThrow('já cadastrado');
  expect(await db.professionalProfile.count({ where: { companyId: a.id } })).toBe(count);
});
