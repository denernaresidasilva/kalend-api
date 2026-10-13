import { randomUUID } from 'node:crypto';
import { UsersService } from './users.service.js';

function setup() {
  const companyA = { id: randomUUID(), name: 'Empresa A', slug: 'a', status: 'ACTIVE', isActive: true };
  const companyB = { id: randomUUID(), name: 'Empresa B', slug: 'b', status: 'TRIAL', isActive: true };
  const now = new Date();
  const user = {
    id: randomUUID(), name: 'OWNER QA', email: 'owner@example.test', phone: null,
    isActive: true, isSuperAdmin: false, createdAt: now, updatedAt: now,
    memberships: [
      { id: randomUUID(), role: 'OWNER', isActive: true, createdAt: now, updatedAt: now, company: companyA },
      { id: randomUUID(), role: 'PROFESSIONAL', isActive: true, createdAt: now, updatedAt: now, company: companyB },
    ],
  };
  const admin = {
    id: randomUUID(), name: 'Super Admin', email: 'admin@example.test', phone: null,
    isActive: true, isSuperAdmin: true, createdAt: now, updatedAt: now, memberships: [],
  };
  const db = {
    user: {
      findMany: vi.fn().mockResolvedValue([user, admin]),
      findUnique: vi.fn().mockImplementation(async (args) => {
        if (args.include) return args.where.id === user.id ? user : null;
        return args.where.id === user.id
          ? { id: user.id, email: user.email, isActive: user.isActive, isSuperAdmin: user.isSuperAdmin }
          : args.where.id === admin.id
            ? { id: admin.id, email: admin.email, isActive: admin.isActive, isSuperAdmin: admin.isSuperAdmin }
            : null;
      }),
      count: vi.fn(),
      update: vi.fn().mockImplementation(async ({ data }) => Object.assign(user, data)),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    membership: {
      findMany: vi.fn().mockImplementation(async ({ where }) =>
        user.memberships.filter((membership) => where.isActive === undefined || membership.isActive)),
      count: vi.fn().mockResolvedValue(0),
      updateMany: vi.fn().mockImplementation(async ({ where, data }) => {
        const rows = user.memberships.filter((membership) => where.userId === user.id && (!where.isActive || membership.isActive));
        rows.forEach((membership) => Object.assign(membership, data));
        return { count: rows.length };
      }),
      upsert: vi.fn().mockImplementation(async ({ where, create, update }) => {
        const existing = user.memberships.find((membership) => membership.company.id === where.userId_companyId.companyId);
        if (existing) Object.assign(existing, update);
        else user.memberships.push({ id: randomUUID(), ...create, createdAt: new Date(), company: { id: create.companyId, name: 'Empresa nova', slug: 'nova', status: 'ACTIVE', isActive: true } });
        return existing ?? user.memberships.at(-1);
      }),
    },
    company: { findMany: vi.fn().mockResolvedValue([companyA, companyB]) },
    authSession: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation((callback) => callback(db));
  return { service: new UsersService(db as never), db, user, admin, companyA, companyB };
}

describe('Super Admin user management', () => {
  it('reports orphan accounts operationally inactive while preserving active Super Admin status', async () => {
    const { service, db, user, admin } = setup();
    user.memberships = [];
    const rows = await service.findAll();
    expect(rows.find((row) => row.id === user.id)).toMatchObject({
      isActive: false,
      accountActive: true,
      canAccessTenant: false,
      memberships: [],
    });
    expect(rows.find((row) => row.id === admin.id)).toMatchObject({
      isActive: true,
      canAccessTenant: true,
      isSuperAdmin: true,
    });
    db.user.count.mockResolvedValueOnce(2).mockResolvedValueOnce(1).mockResolvedValueOnce(1);
    db.membership.count.mockResolvedValue(0);
    await expect(service.summary()).resolves.toMatchObject({
      total: 2, active: 1, inactive: 1, superAdmins: 1,
    });
  });

  it('lists active accounts by default and supports explicit inactive/all views', async () => {
    const { service, db } = setup();
    await service.findAll();
    expect(db.user.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { isActive: true },
    }));
    await service.findAll({ status: 'INACTIVE' });
    expect(db.user.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { isActive: false },
    }));
    await service.findAll({ status: 'ALL' });
    expect(db.user.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: {},
    }));
  });

  it('shows OWNER linked to an irregular existing company as authenticated, separately from commercial access', async () => {
    const { service, user, companyA } = setup();
    companyA.isActive = false;
    companyA.status = 'ACTIVE';
    user.memberships = [user.memberships[0]];
    const row = (await service.findAll()).find((item) => item.id === user.id)!;
    expect(row).toMatchObject({
      isActive: true,
      accountActive: true,
      canAuthenticate: true,
      canAccessTenant: false,
    });
    expect(row.memberships[0]).toMatchObject({ isActive: true, isLinked: true, hasAccess: false });
  });

  it('updates supported profile fields without allowing email or privilege mass assignment', async () => {
    const { service, db, user } = setup();
    await expect(service.update(user.id, { name: 'Nome atualizado', phone: '11999999999' }))
      .resolves.toMatchObject({ name: 'Nome atualizado', phone: '11999999999' });
    expect(db.user.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: user.id }, data: { name: 'Nome atualizado', phone: '11999999999' },
    }));
    await expect(service.update(user.id, { email: 'attacker@example.test' })).rejects.toThrow('Campo não permitido');
    await expect(service.update(user.id, { isSuperAdmin: true })).rejects.toThrow('Campo não permitido');
  });

  it('validates companies and roles and preserves memberships explicitly retained for multi-company users', async () => {
    const { service, db, user, companyB } = setup();
    await expect(service.update(user.id, { memberships: [{ companyId: companyB.id, role: 'SUPER_ADMIN', isActive: true }] }))
      .rejects.toThrow('Função inválida');
    db.company.findMany.mockResolvedValue([companyB]);
    const updated = await service.update(user.id, {
      memberships: [{ companyId: companyB.id, role: 'PROFESSIONAL', isActive: true }],
    });
    expect(db.membership.updateMany).toHaveBeenCalledWith({
      where: { userId: user.id }, data: { isActive: false },
    });
    expect(db.membership.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId_companyId: { userId: user.id, companyId: companyB.id } },
      update: { role: 'PROFESSIONAL', isActive: true },
    }));
    expect(updated.memberships).toHaveLength(2);
    db.company.findMany.mockResolvedValue([]);
    await expect(service.update(user.id, {
      memberships: [{ companyId: randomUUID(), role: 'OWNER', isActive: true }],
    })).rejects.toThrow('Uma ou mais empresas não existem');
  });

  it('deactivates orphan users and revokes sessions when their final membership is removed', async () => {
    const { service, db, user } = setup();
    await service.update(user.id, { memberships: [] });
    expect(db.user.update).toHaveBeenCalledWith({ where: { id: user.id }, data: { isActive: false } });
    expect(db.authSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: user.id, revokedAt: null },
    }));
  });

  it('does not deactivate an OWNER whose existing company is commercially inactive', async () => {
    const { service, db, user, companyA } = setup();
    companyA.isActive = false;
    companyA.status = 'ACTIVE';
    db.company.findMany.mockResolvedValue([companyA]);
    await service.update(user.id, {
      memberships: [{ companyId: companyA.id, role: 'OWNER', isActive: true }],
    });
    expect(user.isActive).toBe(true);
    expect(db.authSession.updateMany).not.toHaveBeenCalled();
  });

  it('soft-deletes a common user, deactivates links and revokes all sessions after exact email confirmation', async () => {
    const { service, db, user } = setup();
    await expect(service.remove(user.id, { confirmationEmail: 'wrong@example.test' }))
      .rejects.toThrow('O e-mail de confirmação não corresponde');
    expect(db.user.updateMany).not.toHaveBeenCalled();
    await expect(service.remove(user.id, { confirmationEmail: user.email }))
      .resolves.toEqual({ deactivated: true, userId: user.id });
    expect(db.user.updateMany).toHaveBeenCalledWith({
      where: { id: user.id, isSuperAdmin: false }, data: { isActive: false },
    });
    expect(db.membership.updateMany).toHaveBeenCalledWith({
      where: { userId: user.id, isActive: true }, data: { isActive: false },
    });
    expect(db.authSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: user.id, revokedAt: null },
    }));
    expect(db.user).not.toHaveProperty('delete');
  });

  it('accepts email confirmation case-insensitively like login', async () => {
    const { service, user } = setup();
    await expect(service.remove(user.id, { confirmationEmail: user.email.toUpperCase() }))
      .resolves.toEqual({ deactivated: true, userId: user.id });
  });

  it('never allows deleting or deactivating a Super Admin', async () => {
    const { service, db, admin } = setup();
    await expect(service.remove(admin.id, { confirmationEmail: admin.email })).rejects.toThrow('Super Admin não pode ser excluído');
    await expect(service.update(admin.id, { isActive: false })).rejects.toThrow('Não é permitido desativar');
    expect(db.user.updateMany).not.toHaveBeenCalled();
    expect(db.authSession.updateMany).not.toHaveBeenCalled();
  });
});
