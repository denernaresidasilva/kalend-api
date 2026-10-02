import {
  NotificationsService,
  safeNotificationUrl,
  decodeCursor,
} from './notifications.service.js';
import type { AuthIdentity } from '../auth/auth.types.js';
const auth = {
  user: { id: 'user', isSuperAdmin: false },
  session: { selectedCompanyId: 'company' },
} as AuthIdentity;
const now = new Date('2026-10-02T10:00:00Z');
function fixture() {
  const db = {
    $queryRaw: vi.fn(async () => [{ now }]),
    membership: { findFirst: vi.fn(async () => ({ role: 'CLIENT' })) },
    notification: {
      count: vi.fn(async () => 3),
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 2 })),
    },
    notificationPreference: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async ({ update }) => update),
    },
  };
  return { db, service: new NotificationsService(db as never) };
}
describe('notification authenticated contracts', () => {
  it('rejects unsafe destinations', () => {
    expect(safeNotificationUrl('/conta/notificacoes')).toBe(
      '/conta/notificacoes',
    );
    for (const value of [
      'https://evil.test',
      '//evil.test',
      'javascript:alert(1)',
      '/auth/logout',
      '/conta?token=x',
      '/conta#token',
      '/super-admin/financeiro',
    ])
      expect(safeNotificationUrl(value)).toBeNull();
  });
  it.each(['OWNER', 'ADMIN', 'PROFESSIONAL', 'RECEPTIONIST', 'CLIENT'])(
    'accepts actual %s membership without authorizing from browser role',
    async (role) => {
      const { service, db } = fixture();
      db.membership.findFirst.mockResolvedValue({ role });
      expect((await service.count(auth)).unreadCount).toBe(3);
      expect(db.notification.count).toHaveBeenCalledWith({
        where: {
          userId: 'user',
          expiresAt: { gt: now },
          OR: [{ companyId: null }, { companyId: 'company' }],
          readAt: null,
        },
      });
    },
  );
  it('global Super Admin does not require a tenant and sees only own global history', async () => {
    const { service, db } = fixture();
    await service.count({
      ...auth,
      user: { ...auth.user, isSuperAdmin: true },
      session: { ...auth.session, selectedCompanyId: null },
    });
    expect(db.membership.findFirst).not.toHaveBeenCalled();
    expect(db.notification.count.mock.calls[0][0].where.OR).toEqual([
      { companyId: null },
    ]);
  });
  it('rejects stale or unauthorized selected company before reading inbox', async () => {
    const { service, db } = fixture();
    db.membership.findFirst.mockResolvedValue(null as never);
    await expect(service.count(auth)).rejects.toThrow(
      'Empresa sem vínculo autorizado.',
    );
    expect(db.notification.count).not.toHaveBeenCalled();
  });
  it('does not distinguish another user notification from nonexistent notification', async () => {
    const { service, db } = fixture();
    await expect(service.read(auth, 'other-user-id')).rejects.toThrow(
      'Notificação não encontrada.',
    );
    expect(db.notification.updateMany).not.toHaveBeenCalled();
  });
  it('marks all using authorized scope and server timestamp', async () => {
    const { service, db } = fixture();
    expect((await service.read(auth)).updated).toBe(2);
    expect(db.notification.updateMany.mock.calls[0][0].data).toEqual({
      readAt: now,
    });
    expect(
      db.notification.updateMany.mock.calls[0][0].where.AND[0].userId,
    ).toBe('user');
  });
  it.each([
    { limit: '21' },
    { limit: '0' },
    { limit: '1.5' },
    { filter: 'invalid' },
    { userId: 'other' },
    { companyId: 'other' },
    { cursor: 'bad' },
  ])('rejects malformed query %j', async (query) => {
    await expect(fixture().service.list(auth, query)).rejects.toThrow();
  });
  it('bounds list to twenty plus one and uses stable ordering', async () => {
    const { service, db } = fixture();
    const result = await service.list(auth);
    expect(result.nextCursor).toBeNull();
    expect(result.serverNow).toBe(now);
    expect(db.notification.findMany.mock.calls[0][0].take).toBe(21);
  });
  it('validates cursor structure, types and size', () => {
    for (const value of [
      'x',
      'a'.repeat(251),
      Buffer.from(
        JSON.stringify({ id: 'invalid', createdAt: 'today' }),
      ).toString('base64url'),
    ])
      expect(() => decodeCursor(value)).toThrow();
  });
  it('preferences are server-persisted and contain no mutable role or tenant', async () => {
    const { service, db } = fixture();
    expect(await service.preferences(auth)).toEqual({ inSystemEnabled: true });
    expect(
      await service.setPreferences(auth, { inSystemEnabled: false }),
    ).toEqual({ inSystemEnabled: false });
    expect(db.notificationPreference.upsert.mock.calls[0][0].where).toEqual({
      userId: 'user',
    });
    for (const value of [
      {},
      { inSystemEnabled: 'true' },
      { inSystemEnabled: true, userId: 'other' },
    ])
      await expect(service.setPreferences(auth, value)).rejects.toThrow();
  });
  it('cleanup physically deletes using database time without browser interaction', async () => {
    const { service, db } = fixture();
    db.$queryRaw.mockResolvedValue([{ id: 'deleted' }] as never);
    expect(await service.cleanup()).toEqual({ deleted: 1 });
    const sql = db.$queryRaw.mock.calls[0][0].join('');
    expect(sql).toContain('DELETE FROM "Notification"');
    expect(sql).toContain('CURRENT_TIMESTAMP');
    expect(sql).toContain('SKIP LOCKED');
  });
});
