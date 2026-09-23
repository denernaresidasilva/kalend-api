import * as bcrypt from 'bcrypt';
import { createFirstAdmin } from './admin-bootstrap.js';
// Only the pure bootstrap function is tested with a fake client. The interactive CLI is never run.
describe('controlled first admin bootstrap', () => {
  let hash: string;
  beforeAll(async () => {
    hash = await bcrypt.hash('test-only-strong-password', 12);
  });
  function setup() {
    const db = {
      user: {
        count: vi.fn().mockResolvedValue(0),
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
        update: vi.fn(),
      },
      authSession: { updateMany: vi.fn() },
      $executeRaw: vi.fn(),
      $transaction: vi.fn(),
    };
    db.$transaction.mockImplementation((fn) => fn(db));
    return db;
  }
  const input = {
    email: 'admin@example.test',
    name: 'Admin',
    password: 'test-only-strong-password',
    promote: false,
  };
  it('creates global privilege without membership', async () => {
    const db = setup();
    await createFirstAdmin(db as never, input);
    expect(db.$executeRaw).toHaveBeenCalledOnce();
    const data = db.user.create.mock.calls[0][0].data;
    expect(data.isSuperAdmin).toBe(true);
    expect(data.passwordHash).not.toBe(input.password);
    expect(data).not.toHaveProperty('memberships');
  });
  it('refuses another bootstrap if any global admin already exists', async () => {
    const db = setup();
    db.user.count.mockResolvedValue(1);
    await expect(createFirstAdmin(db as never, input)).rejects.toThrow(
      'Já existe',
    );
    expect(db.user.create).not.toHaveBeenCalled();
  });
  it('does not silently promote an existing user', async () => {
    const db = setup();
    db.user.findUnique.mockResolvedValue({ id: 'u' } as never);
    await expect(createFirstAdmin(db as never, input)).rejects.toThrow(
      'Usuário já existe',
    );
    expect(db.user.update).not.toHaveBeenCalled();
  });
  it('requires explicit promotion and current password; revokes prior sessions', async () => {
    const db = setup();
    db.user.findUnique.mockResolvedValue({
      id: 'u',
      isActive: true,
      passwordHash: hash,
    } as never);
    await createFirstAdmin(db as never, { ...input, promote: true });
    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: 'u' },
      data: { isSuperAdmin: true },
    });
    expect(db.authSession.updateMany).toHaveBeenCalledOnce();
    expect(db.user.create).not.toHaveBeenCalled();
  });
});
