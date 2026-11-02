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
  expect((await bookings.catalog(b.slug)).services.some(s => s.id === result.service.id)).toBe(true);
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
