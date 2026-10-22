import { CompaniesService } from './companies.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { EvolutionService } from '../communication/evolution.js';
import { safeUserSelect } from '../common/validation.js';
const planId = '11111111-1111-4111-8111-111111111111';
const input = {
  companyName: 'Teste',
  slug: 'teste',
  ownerName: 'Ana',
  ownerEmail: 'ana@example.test',
  ownerPassword: 'a-long-password',
  planId,
};
function setup(existing = false) {
  const plan = {
    id: planId,
    isActive: true,
    trialEnabled: true,
    trialDays: 7,
    yearlyPriceCents: 10000,
  };
  const db = {
    subscriptionEntitlement: { create: vi.fn(), count: vi.fn().mockResolvedValue(0) },
    payment: { count: vi.fn().mockResolvedValue(0) },
    plan: { findUnique: vi.fn().mockResolvedValue(plan) },
    user: {
      findUnique: vi
        .fn()
        .mockImplementation(async ({ where }) => where.id === 'admin' ? { id: 'admin', isActive: true, isSuperAdmin: true } : existing ? { id: 'owner', isActive: true } : null),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      upsert: vi
        .fn()
        .mockImplementation(({ create }) => ({ ...create, id: 'owner' })),
    },
    company: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi
        .fn()
        .mockImplementation(({ data }) => ({ ...data, id: 'company' })),
      update: vi.fn().mockResolvedValue({ id: 'company' }),
      delete: vi.fn().mockResolvedValue({ id: 'company' }),
      findMany: vi.fn(),
    },
    membership: {
      create: vi.fn().mockResolvedValue({ id: 'membership', role: 'OWNER' }),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      upsert: vi.fn().mockResolvedValue({ id: 'membership', role: 'OWNER' }),
    },
    authSession: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    subscription: {
      count: vi.fn().mockResolvedValue(0),
      create: vi
        .fn()
        .mockImplementation(({ data }) => ({ ...data, id: 'sub', plan })),
      findFirst: vi.fn().mockResolvedValue({ id: 'sub', status: 'TRIALING' }),
      update: vi.fn().mockResolvedValue({ id: 'sub' }),
    },
    webhookEvent: { count: vi.fn().mockResolvedValue(0), deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    globalCommunicationOutbox: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    globalCommunicationDelivery: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    globalCommunicationLog: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    evolutionConnection: { findUnique: vi.fn().mockResolvedValue({ companyId: 'company', globalKey: null, prepared: false, status: 'PENDING' }) },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation((fn) => fn(db));
  return { db, service: new CompaniesService(db as unknown as PrismaService) };
}
describe('manual company', () => {
  it('changing catalog trial days only affects trials created afterwards', async () => {
    const { db, service } = setup();
    const first = await service.createManual(input, 'admin');
    const originalEnd = first.subscription.trialEndsAt!.getTime();
    const plan = await db.plan.findUnique();
    plan.trialDays = 14;
    const second = await service.createManual(input, 'admin');
    expect(first.subscription.trialEndsAt!.getTime()).toBe(originalEnd);
    expect(
      second.subscription.trialEndsAt!.getTime() -
        second.subscription.trialStartedAt!.getTime(),
    ).toBe(14 * 86400000);
  });
  it('atomically creates owner, membership and trial without fabricating payment', async () => {
    const { db, service } = setup();
    const result = await service.createManual(input, 'admin');
    expect(result.company.status).toBe('TRIAL');
    expect(result.subscription.status).toBe('TRIALING');
    expect(
      result.subscription.trialEndsAt!.getTime() -
        result.subscription.trialStartedAt!.getTime(),
    ).toBe(7 * 86400000);
    expect(db.membership.create).toHaveBeenCalledWith({
      data: {
        companyId: 'company',
        userId: 'owner',
        role: 'OWNER',
        isActive: true,
      },
    });
    expect(db.$transaction).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain('passwordHash');
  });
  it.each([
    '12996015129',
    '5512996015129',
    '+5512996015129',
    '(12) 99601-5129',
  ])('normalizes owner phone on company registration (%s)', async (ownerPhone) => {
    const { service, db } = setup();
    await service.createManual({ ...input, ownerPhone }, 'admin');
    expect(db.user.upsert.mock.calls[0][0].create.phone).toBe('+5512996015129');
  });
  it('rejects an invalid owner phone on company registration', async () => {
    const { service, db } = setup();
    await expect(service.createManual({ ...input, ownerPhone: 'not-a-phone' }, 'admin'))
      .rejects.toThrow('Telefone inválido.');
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it('commits a pending deterministic connection and returns even while Evolution is unavailable', async () => {
    const { db } = setup();
    const prepareAfterCompanyCreated = vi.fn().mockResolvedValue(undefined);
    const service = new CompaniesService(
      db as unknown as PrismaService,
      { prepareAfterCompanyCreated } as unknown as EvolutionService,
    );
    const result = await service.createManual(input, 'admin');
    const data = db.company.create.mock.calls[0][0].data;
    expect(data.evolutionConnection.create.instanceName).toBe(
      `kalend_${data.id.replaceAll('-', '')}`,
    );
    expect(prepareAfterCompanyCreated).toHaveBeenCalledWith(result.company.id);
    expect(result.company.status).toBe('TRIAL');
  });
  it('immediate activation sets paid period but no trial', async () => {
    const { service } = setup();
    const result = await service.createManual({
      ...input,
      startWithTrial: false,
    }, 'admin');
    expect(result.company.status).toBe('ACTIVE');
    expect(result.subscription.status).toBe('ACTIVE');
    expect(result.subscription.trialEndsAt).toBeNull();
    expect(result.subscription.currentPeriodEnd!.getTime()).toBeGreaterThan(
      result.subscription.currentPeriodStart!.getTime(),
    );
  });
  it('reuses user without changing password', async () => {
    const { service, db } = setup(true);
    await service.createManual(input, 'admin');
    expect(db.user.upsert.mock.calls[0][0].update).toEqual({});
  });
  it('selects only safe user columns for company details', async () => {
    const { service, db } = setup();
    await service.findOne(planId);
    expect(
      db.company.findUnique.mock.calls[0][0].include.memberships.include.user,
    ).toEqual({ select: safeUserSelect });
    expect(safeUserSelect).not.toHaveProperty('passwordHash');
  });
  it('administrative disable/enable is explicit and cancellation does not imply administrative disable', async () => {
    const { service, db } = setup();
    db.company.findUnique.mockResolvedValue({ id: 'company' });
    await service.update('company', { status: 'SUSPENDED' });
    expect(db.company.update).toHaveBeenLastCalledWith({
      where: { id: 'company' },
      data: {
        status: 'SUSPENDED',
        isActive: false,
        administrativeStatus: 'DISABLED',
      },
    });
    await service.update('company', { administrativeStatus: 'ACTIVE' });
    expect(db.company.update).toHaveBeenLastCalledWith({
      where: { id: 'company' },
      data: { administrativeStatus: 'ACTIVE', isActive: false },
    });
    await service.update('company', { status: 'CANCELED' });
    expect(db.company.update).toHaveBeenLastCalledWith({
      where: { id: 'company' },
      data: { status: 'CANCELED', isActive: false },
    });
  });
  it('updates company fields, owner membership and the current plan transactionally', async () => {
    const { service, db } = setup();
    db.company.findUnique.mockResolvedValue({ id: 'company' });
    db.user.findUnique.mockResolvedValue({
      id: 'new-owner',
      isActive: true,
      isSuperAdmin: false,
    });
    const result = await service.update('company', {
      name: 'Nome atualizado',
      slug: 'novo-slug',
      timezone: 'UTC',
      status: 'ACTIVE',
      ownerEmail: 'new@example.test',
      planId,
    });
    expect(db.$transaction).toHaveBeenCalledOnce();
    expect(db.company.update).toHaveBeenCalledWith({
      where: { id: 'company' },
      data: {
        administrativeStatus: 'ACTIVE',
        name: 'Nome atualizado',
        slug: 'novo-slug',
        timezone: 'UTC',
        status: 'ACTIVE',
        isActive: true,
      },
    });
    expect(db.membership.updateMany).toHaveBeenCalledWith({
      where: { companyId: 'company', role: 'OWNER', userId: { not: 'new-owner' } },
      data: { role: 'ADMIN' },
    });
    expect(db.membership.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId_companyId: { userId: 'new-owner', companyId: 'company' } },
      update: { role: 'OWNER', isActive: true },
    }));
    expect(db.subscription.update).toHaveBeenCalledWith({
      where: { id: 'sub' },
      data: { planId },
    });
    expect(result).toBeDefined();
  });
  it('rejects a Super Admin as company owner and rolls the transaction back', async () => {
    const { service, db } = setup();
    db.company.findUnique.mockResolvedValue({ id: 'company' });
    db.user.findUnique.mockResolvedValue({
      id: 'admin',
      isActive: true,
      isSuperAdmin: true,
    });
    await expect(service.update('company', { ownerEmail: 'admin@example.test' }))
      .rejects.toThrow('não seja Super Admin');
    expect(db.$transaction).toHaveBeenCalledOnce();
    expect(db.membership.updateMany).not.toHaveBeenCalled();
  });
  it('requires an existing company before editing', async () => {
    const { service, db } = setup();
    await expect(service.update('missing', { name: 'Atualizada' }))
      .rejects.toThrow('Empresa não encontrada');
    expect(db.company.update).not.toHaveBeenCalled();
  });
  it('does not change a paid subscription plan from the company editor', async () => {
    const { service, db } = setup();
    db.company.findUnique.mockResolvedValue({ id: 'company' });
    db.subscription.findFirst.mockResolvedValue({ id: 'sub', status: 'ACTIVE' });
    await expect(service.update('company', { planId }))
      .rejects.toThrow('gestão de assinaturas');
    expect(db.subscription.update).not.toHaveBeenCalled();
  });
  it.each(['payment', 'webhookEvent', 'subscriptionEntitlement', 'subscription'] as const)(
    'preserves companies with %s financial history before any external cleanup', async (model) => {
      const { db } = setup();
      db.company.findUnique.mockResolvedValue({
        id: 'company', name: 'QA Empresa',
        evolutionConnection: { companyId: 'company', globalKey: null, prepared: true, status: 'OPEN' },
      });
      db[model].count.mockResolvedValue(1);
      const remove = vi.fn();
      const service = new CompaniesService(db as unknown as PrismaService, { remove } as unknown as EvolutionService);
      await expect(service.remove('company', { confirmationName: 'QA Empresa' }))
        .rejects.toThrow('COMPANY_FINANCIAL_HISTORY_PRESERVED');
      expect(remove).not.toHaveBeenCalled();
      expect(db.company.delete).not.toHaveBeenCalled();
      expect(db.webhookEvent.deleteMany).not.toHaveBeenCalled();
    },
  );
  it('rechecks financial history inside the serializable deletion transaction', async () => {
    const { db, service } = setup();
    db.company.findUnique.mockResolvedValue({ id: 'company', name: 'QA Empresa', evolutionConnection: null });
    db.payment.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    await expect(service.remove('company', { confirmationName: 'QA Empresa' }))
      .rejects.toThrow('COMPANY_FINANCIAL_HISTORY_PRESERVED');
    expect(db.company.delete).not.toHaveBeenCalled();
    expect(db.webhookEvent.deleteMany).not.toHaveBeenCalled();
  });
  it('requires an exact company-name confirmation and never deletes before it matches', async () => {
    const { service, db } = setup();
    db.company.findUnique.mockResolvedValue({ id: 'company', name: 'QA Empresa', evolutionConnection: null });
    await expect(service.remove('company', { confirmationName: 'qa empresa' }))
      .rejects.toThrow('não corresponde');
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.company.delete).not.toHaveBeenCalled();
  });
  it('deletes only company-scoped communication and webhook data in one transaction, preserving user rows', async () => {
    const { service, db } = setup();
    db.company.findUnique.mockResolvedValue({ id: 'company', name: 'QA Empresa', evolutionConnection: null });
    db.globalCommunicationOutbox.findMany.mockResolvedValue([{ id: 'outbox-a' }]);
    db.globalCommunicationDelivery.findMany.mockResolvedValue([{ id: 'delivery-a' }]);
    await expect(service.remove('company', { confirmationName: 'QA Empresa' }))
      .resolves.toEqual({ deleted: true, companyId: 'company' });
    expect(db.globalCommunicationLog.deleteMany).toHaveBeenCalledWith({
      where: { OR: [{ outboxId: { in: ['outbox-a'] } }, { deliveryId: { in: ['delivery-a'] } }] },
    });
    expect(db.globalCommunicationDelivery.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['delivery-a'] } } });
    expect(db.globalCommunicationOutbox.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['outbox-a'] }, companyId: 'company' } });
    expect(db.webhookEvent.deleteMany).toHaveBeenCalledWith({ where: { companyId: 'company' } });
    expect(db.company.delete).toHaveBeenCalledWith({ where: { id: 'company' } });
    expect(db.user).not.toHaveProperty('delete');
  });
  it('deactivates an owner with no other active company and revokes all of their sessions atomically', async () => {
    const { service, db } = setup();
    db.company.findUnique.mockResolvedValue({ id: 'company', name: 'QA Empresa', evolutionConnection: null });
    db.membership.findMany.mockResolvedValue([{ userId: 'owner' }]);
    db.user.findMany.mockResolvedValue([{ id: 'owner' }]);

    await service.remove('company', { confirmationName: 'QA Empresa' });

    expect(db.user.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['owner'] },
        isSuperAdmin: false,
        memberships: { none: { isActive: true } },
      },
      select: { id: true },
    });
    expect(db.user.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['owner'] },
        isSuperAdmin: false,
        memberships: { none: { isActive: true } },
      },
      data: { isActive: false },
    });
    expect(db.authSession.updateMany).toHaveBeenCalledWith({
      where: { userId: { in: ['owner'] }, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(db.$transaction).toHaveBeenCalledOnce();
    expect(db.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: 'Serializable' },
    );
    expect(db.user).not.toHaveProperty('delete');
  });
  it('preserves users with an active membership in another company and does not revoke their sessions', async () => {
    const { service, db } = setup();
    db.company.findUnique.mockResolvedValue({ id: 'company', name: 'QA Empresa', evolutionConnection: null });
    db.membership.findMany.mockResolvedValue([{ userId: 'shared-user' }]);

    await service.remove('company', { confirmationName: 'QA Empresa' });

    expect(db.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: { in: ['shared-user'] },
        isSuperAdmin: false,
        memberships: { none: { isActive: true } },
      }),
    }));
    expect(db.user.updateMany).not.toHaveBeenCalled();
    expect(db.authSession.updateMany).not.toHaveBeenCalled();
  });
  it('never deactivates or revokes a Super Admin during company deletion', async () => {
    const { service, db } = setup();
    db.company.findUnique.mockResolvedValue({ id: 'company', name: 'QA Empresa', evolutionConnection: null });
    db.membership.findMany.mockResolvedValue([{ userId: 'super-admin' }]);

    await service.remove('company', { confirmationName: 'QA Empresa' });

    expect(db.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ isSuperAdmin: false }),
    }));
    expect(db.user.updateMany).not.toHaveBeenCalled();
    expect(db.authSession.updateMany).not.toHaveBeenCalled();
  });
  it('keeps a company intact if Evolution cleanup fails', async () => {
    const { db } = setup();
    db.company.findUnique.mockResolvedValue({
      id: 'company', name: 'QA Empresa',
      evolutionConnection: { companyId: 'company', globalKey: null, provisionRequested: true, prepared: true, status: 'CONNECTED' },
    });
    const service = new CompaniesService(db as unknown as PrismaService, {
      remove: vi.fn().mockRejectedValue(new Error('provider failed')),
    } as unknown as EvolutionService);
    await expect(service.remove('company', { confirmationName: 'QA Empresa' })).rejects.toThrow('provider failed');
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it('refuses a GLOBAL Evolution link and never calls the global connection cleanup', async () => {
    const { db } = setup();
    db.company.findUnique.mockResolvedValue({
      id: 'company', name: 'QA Empresa',
      evolutionConnection: { companyId: null, globalKey: 'GLOBAL', provisionRequested: true, prepared: true, status: 'CONNECTED' },
    });
    const remove = vi.fn();
    const service = new CompaniesService(db as unknown as PrismaService, {
      remove,
    } as unknown as EvolutionService);
    await expect(service.remove('company', { confirmationName: 'QA Empresa' }))
      .rejects.toThrow('não corresponde');
    expect(remove).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it('does not delete the Company if remote Evolution removal is not confirmed', async () => {
    const { db } = setup();
    db.company.findUnique.mockResolvedValue({
      id: 'company', name: 'QA Empresa',
      evolutionConnection: { companyId: 'company', globalKey: null, provisionRequested: true, prepared: true, status: 'CONNECTED' },
    });
    const service = new CompaniesService(db as unknown as PrismaService, {
      remove: vi.fn().mockResolvedValue({ status: 'DELETING', prepared: true }),
    } as unknown as EvolutionService);
    await expect(service.remove('company', { confirmationName: 'QA Empresa' }))
      .rejects.toThrow('confirmar a remoção segura');
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it('removes only the matching COMPANY Evolution connection before deleting its tenant', async () => {
    const { db } = setup();
    db.company.findUnique.mockResolvedValue({
      id: 'company', name: 'QA Empresa',
      evolutionConnection: { companyId: 'company', globalKey: null, provisionRequested: true, prepared: true, status: 'CONNECTED' },
    });
    const remove = vi.fn().mockResolvedValue({ status: 'PENDING' });
    const service = new CompaniesService(db as unknown as PrismaService, {
      remove,
    } as unknown as EvolutionService);
    await expect(service.remove('company', { confirmationName: 'QA Empresa' }))
      .resolves.toMatchObject({ deleted: true, companyId: 'company' });
    expect(remove).toHaveBeenCalledWith('company');
    expect(db.evolutionConnection.findUnique).toHaveBeenCalledWith({
      where: { companyId: 'company' },
      select: { companyId: true, globalKey: true, prepared: true, status: true },
    });
  });
  it('runs the destructive database cleanup inside a transaction so failures cannot commit partial state', async () => {
    const { service, db } = setup();
    db.company.findUnique.mockResolvedValue({ id: 'company', name: 'QA Empresa', evolutionConnection: null });
    db.company.delete.mockRejectedValue(new Error('database failure'));
    await expect(service.remove('company', { confirmationName: 'QA Empresa' })).rejects.toThrow('database failure');
    expect(db.$transaction).toHaveBeenCalledOnce();
  });
  it.each([
    { startWithTrial: 'false' },
    { companyName: 8 },
    { ownerEmail: 'invalid' },
    { amountCents: 1 },
  ])('rejects invalid runtime input %j', async (extra) => {
    const { service, db } = setup();
    await expect(
      service.createManual({ ...input, ...extra } as never, 'admin'),
    ).rejects.toThrow();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
