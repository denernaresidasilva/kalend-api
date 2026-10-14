import {
  assertCommercialQa,
  QaSimulationService,
} from './qa-simulation.service.js';
import { PaymentsService } from './payments.service.js';
import { GatewayRegistry } from './gateway.provider.js';
import { FinanceService } from '../finance/finance.service.js';
import { DashboardService } from '../dashboard/dashboard.service.js';
import { WebhookProcessor } from './webhook-processor.service.js';
const companyId = '11111111-1111-4111-8111-111111111111';
const dev = {
  EVOLUTION_WEBHOOK_BASE_URL: 'https://api-dev.kalend.tech',
  DATABASE_URL: 'postgresql://test:test@localhost/kalend_dev',
  COMMERCIAL_QA_SIMULATION_ENABLED: 'true',
  QA_COMMUNICATION_COMPANY_IDS: companyId,
};
describe('commercial QA fail closed', () => {
  it('allows only explicit DEV + flag + QA company + Super Admin', () =>
    expect(() => assertCommercialQa(companyId, true, dev)).not.toThrow());
  it.each([
    {
      ...dev,
      EVOLUTION_WEBHOOK_BASE_URL: 'https://api.kalend.tech',
      DATABASE_URL: 'postgresql://test:test@localhost/kalend',
    },
    { ...dev, COMMERCIAL_QA_SIMULATION_ENABLED: 'false' },
    { ...dev, COMMERCIAL_QA_SIMULATION_ENABLED: undefined },
    { ...dev, QA_COMMUNICATION_COMPANY_IDS: '' },
    { ...dev, QA_COMMUNICATION_COMPANY_IDS: `${companyId},invalid` },
    { ...dev, DATABASE_URL: 'postgresql://test:test@localhost/kalend' },
    {
      ...dev,
      EVOLUTION_WEBHOOK_BASE_URL: 'https://api-staging.kalend.tech',
      DATABASE_URL: 'postgresql://test:test@localhost/kalend_staging',
    },
  ])(
    'blocks unsafe runtime even with an explicit simulation flag (%j)',
    (env) =>
      expect(() => assertCommercialQa(companyId, true, env)).toThrow(
        'COMMERCIAL_QA_SIMULATION_BLOCKED',
      ),
  );
  it('rejects non Super Admin and another tenant', () => {
    expect(() => assertCommercialQa(companyId, false, dev)).toThrow();
    expect(() =>
      assertCommercialQa('22222222-2222-4222-8222-222222222222', true, dev),
    ).toThrow();
  });
  it('rejects QA_SIMULATION in normal checkout before database/adapter access', async () => {
    const registry = new GatewayRegistry();
    const get = vi.spyOn(registry, 'get');
    const service = new PaymentsService({} as never, registry, {} as never);
    await expect(
      service.checkout(companyId, {
        planId: companyId,
        gateway: 'QA_SIMULATION',
        billingInterval: 'MONTHLY',
        idempotencyKey: 'qa',
      }),
    ).rejects.toThrow('Gateway inválido');
    expect(get).not.toHaveBeenCalled();
  });
  it('rejects secrets and arbitrary financial values', async () => {
    const service = new QaSimulationService({} as never);
    await expect(
      service.simulate(
        { companyId, action: 'PAYMENT_PENDING', amountCents: 1 },
        { id: companyId, isSuperAdmin: true },
      ),
    ).rejects.toThrow('Campo não permitido');
    await expect(
      service.simulate(
        { companyId, action: 'PAYMENT_PENDING', secret: 'test' },
        { id: companyId, isSuperAdmin: true },
      ),
    ).rejects.toThrow('Campo não permitido');
  });
});
it('rejects QA origin in the external verified-webhook processor before DB access', async () => {
  const processor = new WebhookProcessor({} as never, {} as never, {} as never);
  await expect(
    processor.processVerified('QA_SIMULATION' as never, {} as never),
  ).rejects.toThrow('Gateway inválido');
});
it('finance and dashboard aggregates exclude QA simulation from revenue and payment totals', async () => {
  const groupBy = vi.fn().mockResolvedValue([]),
    aggregate = vi.fn().mockResolvedValue({ _sum: {} });
  const tx = {
    payment: { groupBy, aggregate },
    company: {
      groupBy: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    user: { count: vi.fn().mockResolvedValue(0) },
    subscription: { groupBy: vi.fn().mockResolvedValue([]) },
    webhookEvent: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const db = { $transaction: vi.fn((fn) => fn(tx)) };
  expect((await new FinanceService(db as never).summary()).revenueCents).toBe(
    0,
  );
  expect(
    (await new DashboardService(db as never).summary()).payments.revenueCents,
  ).toBe(0);
  for (const [args] of [...groupBy.mock.calls, ...aggregate.mock.calls])
    expect(args.where.gateway).toEqual({ not: 'QA_SIMULATION' });
});
