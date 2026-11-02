import { EventEmitter } from 'node:events';
import { firstValueFrom } from 'rxjs';
import { BookingEventsService } from './booking-events.service.js';
import type { AuthRequest } from '../auth/auth.types.js';
const companyId = '11111111-1111-4111-8111-111111111111';
function setup(role = 'OWNER') {
  const identity = { user: { id: 'qa-user' }, session: { id: 'qa-session', selectedCompanyId: companyId } };
  const auth = { authenticate: vi.fn().mockResolvedValue(identity), membership: vi.fn().mockResolvedValue({ id: 'qa-member', role }) };
  const entitlements = { current: vi.fn().mockResolvedValue({}) };
  const prisma = { professionalProfile: { findFirst: vi.fn().mockResolvedValue({ id: 'qa-professional' }) } };
  const service = new BookingEventsService(auth as never, entitlements as never, prisma as never);
  const req = { auth: identity, tenant: { companyId, role, membershipId: 'qa-member' }, headers: { cookie: '__Host-kalend_access=private-test-token' } } as AuthRequest;
  const events = (service as unknown as { events: EventEmitter }).events;
  return { service, auth, entitlements, prisma, req, events, identity };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
it('authenticates the initial stream without exposing booking or customer data', async () => {
  const { service, req, auth, entitlements } = setup();
  const first = await firstValueFrom(service.stream(req));
  expect(first).toEqual({ type: 'booking-change', data: { refresh: true } });
  expect(auth.authenticate).toHaveBeenCalledWith('private-test-token');
  expect(entitlements.current).toHaveBeenCalledWith(companyId);
});
it('ignores other companies and revalidates authorization before each own-company event', async () => {
  const { service, req, auth, events } = setup(); const values: unknown[] = [];
  const sub = service.stream(req).subscribe(v => values.push(v));
  try {
    await tick(); expect(values).toHaveLength(1);
    events.emit('change', { companyId: 'other', professionalIds: [] }); await tick(); expect(values).toHaveLength(1);
    events.emit('change', { companyId, professionalIds: [] }); await tick(); expect(values).toHaveLength(2);
    expect(auth.authenticate).toHaveBeenCalledTimes(2);
  } finally { sub.unsubscribe(); }
});
it('closes a stream when the selected tenant changes', async () => {
  const { service, req, identity } = setup(); identity.session.selectedCompanyId = 'another';
  await expect(firstValueFrom(service.stream(req))).rejects.toThrow('contexto da sessão mudou');
});
it('closes a stream on revocation or membership-role change', async () => {
  const { service, req, auth } = setup(); auth.membership.mockResolvedValue({ id: 'qa-member', role: 'CLIENT' });
  await expect(firstValueFrom(service.stream(req))).rejects.toThrow('vínculo da sessão mudou');
  auth.authenticate.mockRejectedValue(new Error('REVOKED'));
  await expect(firstValueFrom(service.stream(req))).rejects.toThrow('REVOKED');
});
it('does not refresh a professional for a colleagues booking', async () => {
  const { service, req, events } = setup('PROFESSIONAL'); const values: Array<{ type?: string }> = [];
  const sub = service.stream(req).subscribe(v => values.push(v));
  try {
    await tick(); events.emit('change', { companyId, professionalIds: ['colleague'] }); await tick();
    expect(values.at(-1)?.type).toBe('heartbeat');
    events.emit('change', { companyId, professionalIds: ['qa-professional'] }); await tick();
    expect(values.at(-1)?.type).toBe('booking-change');
  } finally { sub.unsubscribe(); }
});
it('limits simultaneous connections and releases listeners on disconnect', async () => {
  const { service, req, events } = setup(); const subs = Array.from({ length: 3 }, () => service.stream(req).subscribe());
  try {
    await expect(firstValueFrom(service.stream(req))).rejects.toThrow('Limite de conexões');
    expect(events.listenerCount('change')).toBe(3);
  } finally { subs.forEach(s => s.unsubscribe()); }
  expect(events.listenerCount('change')).toBe(0);
  await expect(firstValueFrom(service.stream(req))).resolves.toHaveProperty('type', 'booking-change');
});
