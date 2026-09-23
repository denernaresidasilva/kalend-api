import { CompaniesService } from './companies.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
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
    plan: { findUnique: vi.fn().mockResolvedValue(plan) },
    user: {
      findUnique: vi
        .fn()
        .mockResolvedValue(existing ? { id: 'owner', isActive: true } : null),
      upsert: vi
        .fn()
        .mockImplementation(({ create }) => ({ ...create, id: 'owner' })),
    },
    company: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi
        .fn()
        .mockImplementation(({ data }) => ({ ...data, id: 'company' })),
      findMany: vi.fn(),
    },
    membership: {
      create: vi.fn().mockResolvedValue({ id: 'membership', role: 'OWNER' }),
    },
    subscription: {
      create: vi
        .fn()
        .mockImplementation(({ data }) => ({ ...data, id: 'sub', plan })),
    },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation((fn) => fn(db));
  return { db, service: new CompaniesService(db as unknown as PrismaService) };
}
describe('manual company', () => {
  it('atomically creates owner, membership and trial without fabricating payment', async () => {
    const { db, service } = setup();
    const result = await service.createManual(input);
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
  it('immediate activation sets paid period but no trial', async () => {
    const { service } = setup();
    const result = await service.createManual({
      ...input,
      startWithTrial: false,
    });
    expect(result.company.status).toBe('ACTIVE');
    expect(result.subscription.status).toBe('ACTIVE');
    expect(result.subscription.trialEndsAt).toBeNull();
    expect(result.subscription.currentPeriodEnd!.getTime()).toBeGreaterThan(
      result.subscription.currentPeriodStart!.getTime(),
    );
  });
  it('reuses user without changing password', async () => {
    const { service, db } = setup(true);
    await service.createManual(input);
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
  it.each([
    { startWithTrial: 'false' },
    { companyName: 8 },
    { ownerEmail: 'invalid' },
    { amountCents: 1 },
  ])('rejects invalid runtime input %j', async (extra) => {
    const { service, db } = setup();
    await expect(
      service.createManual({ ...input, ...extra } as never),
    ).rejects.toThrow();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
