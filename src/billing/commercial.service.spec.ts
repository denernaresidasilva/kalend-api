import { EntitlementsService } from './entitlements.service.js';
import { RegularizationService } from './regularization.service.js';
import { GatewaysService } from './gateways.service.js';
import { SecretVault } from './secret-vault.js';
import { GatewayRegistry, gateways } from './gateway.provider.js';
import { PlansService } from '../plans/plans.service.js';
import { validatePlan } from '../plans/plan.validation.js';
afterEach(() => vi.unstubAllEnvs());
describe('configuration', () => {
  function setup() {
    vi.stubEnv('GATEWAY_ENCRYPTION_KEY', 'ab'.repeat(32));
    let row: any = null;
    const db = {
      gatewayConfiguration: {
        findUnique: vi.fn().mockImplementation(() => row),
        create: vi
          .fn()
          .mockImplementation(
            ({ data }) => (row = { ...data, updatedAt: new Date() }),
          ),
        updateMany: vi.fn().mockImplementation(({ data }) => {
          for (const [key, value] of Object.entries(data))
            if (value !== undefined) row[key] = value;
          return { count: 1 };
        }),
      },
      payment: { count: vi.fn().mockResolvedValue(0) },
      $transaction: vi.fn(),
    };
    db.$transaction.mockImplementation((fn) => fn(db));
    const test = vi.fn().mockResolvedValue(undefined);
    const registry = {
      get: () => ({
        test,
        capabilities: new GatewayRegistry().get('STRIPE').capabilities,
      }),
    };
    return {
      db,
      test,
      service: new GatewaysService(
        db as never,
        new SecretVault(),
        registry as never,
      ),
      row: () => row,
    };
  }
  it.each(gateways)(
    '%s encrypts writes, returns flags, requires real connection test before enabling',
    async (gateway) => {
      const { service, row, test } = setup();
      await service.update(gateway, {
        credentials: 'fixture-api',
        ...(gateway === 'PAGBANK' ? {} : { webhookSecret: 'fixture-webhook' }),
      });
      expect(row().credentialsEncrypted).not.toContain('fixture-api');
      await expect(service.update(gateway, { enabled: true })).rejects.toThrow(
        'GATEWAY_VALIDATION_REQUIRED',
      );
      await service.test(gateway);
      await service.update(gateway, { enabled: true });
      expect(test).toHaveBeenCalledOnce();
      const result = await service.get(gateway);
      expect(result.enabled).toBe(true);
      expect(result.configured).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(
        /fixture-api|fixture-webhook|Encrypted/,
      );
      await service.update(gateway, { credentials: 'replacement-fixture' });
      expect(row().enabled).toBe(false);
      expect(row().status).toBe('PENDING_VALIDATION');
    },
  );
  it('PagBank never persists a manually supplied public key as a secret and exposes test checks', async () => {
    const { service, row, test } = setup();
    await expect(
      service.update('PAGBANK', { webhookSecret: 'public-fixture' }),
    ).rejects.toThrow('PAGBANK_WEBHOOK_KEY_MANAGED_BY_PROVIDER');
    expect(row()).toBeNull();
    await service.update('PAGBANK', {
      credentials: 'fixture',
      recurringCredentials: 'fixture-recurring',
      recurringEnabled: true,
    });
    test.mockResolvedValue({
      credentials: 'CREDENTIALS_VALID',
      webhookKey: 'WEBHOOK_KEY_AVAILABLE',
      reconciliation: 'RECONCILIATION_UNVERIFIED',
    });
    expect(await service.test('PAGBANK')).toMatchObject({
      checks: { reconciliation: 'RECONCILIATION_UNVERIFIED' },
    });
    expect(row().webhookSecretEncrypted).toBeUndefined();
    expect((await service.get('PAGBANK')).webhookStatus).toBe(
      'REMOTE_KEY_UNVERIFIED',
    );
  });
  it('Asaas rejects API key reused as webhook token including partial replacement', async () => {
    const { service } = setup();
    await service.update('ASAAS', {
      credentials: 'api-fixture',
      webhookSecret: 'hook-fixture',
    });
    await expect(
      service.update('ASAAS', { webhookSecret: 'api-fixture' }),
    ).rejects.toThrow('WEBHOOK_SEPARATE_SECRET_REQUIRED');
  });
  it('does not relabel history or reuse sandbox credentials in production', async () => {
    const { service, db } = setup();
    await service.update('STRIPE', {
      credentials: 'fixture',
      webhookSecret: 'hook',
    });
    await expect(
      service.update('STRIPE', { environment: 'PRODUCTION' }),
    ).rejects.toThrow();
    db.payment.count.mockResolvedValue(1);
    await expect(
      service.update('STRIPE', {
        environment: 'PRODUCTION',
        credentials: 'other',
        webhookSecret: 'other-hook',
      }),
    ).rejects.toThrow('GATEWAY_HAS_FINANCIAL_HISTORY');
  });
  it('failed connection remains disabled, hides provider exception', async () => {
    const { service, row, test } = setup();
    await service.update('STRIPE', {
      credentials: 'fixture',
      webhookSecret: 'hook',
    });
    test.mockRejectedValue(new Error('sensitive-provider-message'));
    await expect(service.test('STRIPE')).rejects.toThrow(
      'GATEWAY_CONNECTION_FAILED',
    );
    expect(row().status).toBe('FAILED');
    expect(row().enabled).toBe(false);
  });
});
describe('commercial access', () => {
  it('returns structured limit error using DB membership count; no frontend usage input', async () => {
    const db = {
      membership: { count: vi.fn().mockResolvedValue(5) },
      subscription: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ plan: { maxProfessionals: 5, features: [] } }),
      },
    };
    const service = new EntitlementsService(db as never);
    try {
      await service.assertMembershipLimit(
        db as never,
        'company',
        'PROFESSIONAL',
      );
      throw new Error('missing rejection');
    } catch (e: any) {
      expect(e.getResponse()).toEqual({
        code: 'PLAN_LIMIT_REACHED',
        feature: 'professionals',
        current: 5,
        limit: 5,
        upgradeRequired: true,
      });
    }
  });
  it('rejects expired entitlement and disabled feature; permits unlimited configured limit', async () => {
    const db = { subscription: { findFirst: vi.fn().mockResolvedValue(null) } };
    const service = new EntitlementsService(db as never);
    await expect(service.current('company')).rejects.toThrow();
    db.subscription.findFirst.mockResolvedValue({
      plan: {
        maxClients: null,
        features: [{ code: 'reports', enabled: false }],
      },
    } as never);
    await expect(
      service.assertLimit(db as never, 'company', 'clients', 1000),
    ).resolves.toBeUndefined();
    await expect(service.assertFeature('company', 'reports')).rejects.toThrow();
  });
  it('regularization exposes expired trial and alternate public plans without credentials', async () => {
    const db = {
      subscription: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({
            id: 'trial',
            status: 'EXPIRED',
            planId: 'premium',
            plan: { name: 'Premium' },
            trialEndsAt: new Date(0),
          }),
      },
      payment: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    const service = new RegularizationService(
      db as never,
      { findPublic: async () => [{ id: 'pro' }] } as never,
      {
        list: async () => [
          {
            gateway: 'ASAAS',
            enabled: true,
            status: 'CONNECTED',
            environment: 'SANDBOX',
            capabilities: {},
          },
        ],
      } as never,
      {} as never,
    );
    expect(await service.get('company')).toMatchObject({
      status: 'TRIAL_EXPIRED',
      accessAllowed: false,
      plans: [{ id: 'pro' }],
      gateways: [{ provider: 'ASAAS' }],
    });
  });
  it.each([false, true])(
    'cancels externally before local transition, atPeriodEnd=%s',
    async (atPeriodEnd) => {
      const db = {
        subscription: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'sub',
            companyId: 'company',
            gateway: 'STRIPE',
            environment: 'SANDBOX',
            externalSubscriptionId: 'sub_external',
            status: 'ACTIVE',
            currentPeriodEnd: new Date(Date.now() + 86400000),
          }),
          update: vi.fn(),
          count: vi.fn().mockResolvedValue(0),
        },
        company: { update: vi.fn() },
        $transaction: vi.fn(),
      };
      db.$transaction.mockImplementation((fn) => fn(db));
      const cancelSubscription = vi.fn().mockResolvedValue(undefined);
      const service = new RegularizationService(
        db as never,
        {} as never,
        { context: async () => ({ environment: 'SANDBOX' }) } as never,
        {
          get: () => ({
            capabilities: { cancelAtPeriodEnd: true },
            cancelSubscription,
          }),
        } as never,
      );
      await service.cancel('company', 'sub', { atPeriodEnd });
      expect(cancelSubscription).toHaveBeenCalledWith(
        'sub_external',
        { environment: 'SANDBOX' },
        atPeriodEnd,
      );
      expect(db.subscription.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ cancelAtPeriodEnd: atPeriodEnd }),
        }),
      );
      expect(db.company.update.mock.calls.length).toBe(atPeriodEnd ? 0 : 1);
    },
  );
  it('public catalog filters private/inactive plans and selects commercial fields', async () => {
    const db = { plan: { findMany: vi.fn() } };
    await new PlansService(db as never).findPublic();
    expect(db.plan.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { isPublic: true, isActive: true },
        select: expect.objectContaining({
          monthlyPriceCents: true,
          features: expect.any(Object),
        }),
      }),
    );
    expect(() =>
      validatePlan({ maxClients: null, isPublic: false }, true),
    ).not.toThrow();
  });
});
