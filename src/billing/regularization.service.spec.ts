import { RegularizationService } from './regularization.service.js';
import { entitledWhere } from './commercial-policy.js';
const now = new Date('2026-10-01T23:00:00.000Z');
const day = 86400000;
function setup(status: string | null, offset = 0, entitled = false) {
  const sub = status
    ? {
        id: 'sub',
        companyId: 'company',
        status,
        planId: 'plan',
        plan: { name: 'Plan' },
        trialEndsAt:
          status === 'TRIALING' || status === 'EXPIRED'
            ? new Date(now.getTime() + offset)
            : null,
        graceEndsAt:
          status === 'PAST_DUE' ? new Date(now.getTime() + offset) : null,
      }
    : null;
  const db = {
    subscription: {
      findFirst: vi
        .fn()
        .mockResolvedValueOnce(entitled ? sub : null)
        .mockResolvedValue(sub),
    },
    payment: { findFirst: vi.fn().mockResolvedValue(null) },
  };
  const plans = { findPublic: vi.fn().mockResolvedValue([]) };
  const gateways = { list: vi.fn().mockResolvedValue([]) };
  return {
    db,
    plans,
    gateways,
    service: new RegularizationService(
      db as never,
      plans as never,
      gateways as never,
      {} as never,
    ),
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(() => vi.useRealTimers());
it.each([
  [3 * day, 3],
  [3 * day - 1, 3],
  [2 * day, 2],
  [2 * day - 1, 2],
  [day, 1],
  [day - 1, 1],
  [1, 1],
  [0, 0],
  [-1, 0],
  [-day, 0],
])(
  'trial offset %s has %s days using the same server instant',
  async (offset, remainingDays) => {
    const { service, db } = setup('TRIALING', offset, offset > 0);
    const result = await service.get('company');
    expect(result.serverNow).toBe(now.toISOString());
    expect(result.trial).toEqual({
      active: offset > 0,
      endsAt: new Date(now.getTime() + offset),
      expired: offset <= 0,
      remainingDays,
    });
    expect(result.trialExpired).toBe(result.trial.expired);
    expect(result.financial.requiresAction).toBe(false);
    expect(db.subscription.findFirst).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ where: entitledWhere('company', now) }),
    );
  },
);
it.each([
  ['ACTIVE', day, true, false],
  ['PAST_DUE', day, true, false],
  ['PAST_DUE', 0, false, true],
  ['PAST_DUE', -1, false, true],
  ['SUSPENDED', 0, false, true],
  [null, 0, false, true],
])(
  'preserves financial policy for %s offset %s',
  async (status, offset, entitled, requiresAction) => {
    const { service } = setup(status, offset, entitled);
    expect((await service.get('company')).financial).toEqual({
      requiresAction,
      status,
      paymentStatus: null,
    });
  },
);
it.each(['PENDING', 'FAILED', 'OVERDUE', 'APPROVED', 'REFUNDED', 'CANCELED'])(
  'returns persisted payment status %s without granting access',
  async (status) => {
    const { service, db } = setup('SUSPENDED');
    db.payment.findFirst.mockResolvedValueOnce({ status } as never);
    const result = await service.get('company', 'CLIENT');
    expect(result.financial).toEqual({
      requiresAction: true,
      status: 'SUSPENDED',
      paymentStatus: status,
    });
    expect(db.payment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { companyId: 'company', subscriptionId: 'sub' },
        select: { status: true },
      }),
    );
  },
);
it('no trial is represented explicitly and operational billing fields are restricted', async () => {
  const { service, db, gateways, plans } = setup('ACTIVE', 0, true);
  const result = await service.get('company', 'PROFESSIONAL');
  expect(result.trial).toEqual({
    active: false,
    endsAt: null,
    expired: false,
    remainingDays: 0,
  });
  expect(result.pendingCheckout).toBeNull();
  expect(result.gateways).toEqual([]);
  expect(gateways.list).not.toHaveBeenCalled();
  expect(plans.findPublic).not.toHaveBeenCalled();
  expect(db.payment.findFirst).toHaveBeenCalledOnce();
});
it.each(['USER', 'SUPER_ADMIN'] as const)(
  'does not query tenant billing for %s without applicable context',
  (role) => {
    const { service, db } = setup(null);
    expect(service.withoutCompany(role)).toMatchObject({
      serverNow: now.toISOString(),
      companyId: null,
      context: { systemRole: role, commercialApplicable: false },
      financial: { requiresAction: false },
      trial: { active: false, expired: false, remainingDays: 0 },
    });
    expect(db.subscription.findFirst).not.toHaveBeenCalled();
  },
);
