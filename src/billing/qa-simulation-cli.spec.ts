import { parseQaCli, qaCliFailure, runQaCli } from './qa-simulation-cli.js';
import { QA_TRANSITIONS } from './qa-simulation.service.js';
const companyId = '11111111-1111-4111-8111-111111111111';
const paymentId = '22222222-2222-4222-8222-222222222222';
const dev = {
  EVOLUTION_WEBHOOK_BASE_URL: 'https://api-dev.kalend.tech',
  BILLING_PUBLIC_API_URL: 'https://api-dev.kalend.tech',
  DATABASE_URL: 'postgresql://test:test@localhost/kalend_dev',
  COMMERCIAL_QA_SIMULATION_ENABLED: 'true',
  QA_COMMUNICATION_COMPANY_IDS: companyId,
};
const pending = [
  '--company',
  companyId,
  '--action',
  'PAYMENT_PENDING',
  '--plan',
  paymentId,
  '--interval',
  'MONTHLY',
  '--key',
  'stable-attempt',
];
describe('commercial QA CLI', () => {
  it('passes catalog identifiers to the same service without an HTTP actor or credentials', async () => {
    const simulateFromCli = vi
      .fn()
      .mockResolvedValue({ source: 'QA_SIMULATION', paymentId });
    const close = vi.fn();
    const open = vi
      .fn()
      .mockResolvedValue({ service: { simulateFromCli }, close });
    const output = vi.fn();
    await runQaCli(pending, open, output, dev);
    expect(simulateFromCli).toHaveBeenCalledExactlyOnceWith({
      companyId,
      action: 'PAYMENT_PENDING',
      planId: paymentId,
      billingInterval: 'MONTHLY',
      idempotencyKey: 'stable-attempt',
    });
    expect(output).toHaveBeenCalledWith({
      execution: 'CLI',
      source: 'QA_SIMULATION',
      paymentId,
    });
    expect(close).toHaveBeenCalledTimes(1);
  });
  it.each(QA_TRANSITIONS)(
    'accepts %s against the existing payment',
    (action) => {
      expect(
        parseQaCli([
          '--company',
          companyId,
          '--action',
          action,
          '--payment',
          paymentId,
        ]),
      ).toEqual({ mode: 'SIMULATE', input: { companyId, action, paymentId } });
    },
  );
  it.each([
    {
      ...dev,
      EVOLUTION_WEBHOOK_BASE_URL: 'https://api.kalend.tech',
      BILLING_PUBLIC_API_URL: 'https://api.kalend.tech',
      DATABASE_URL: 'postgresql://test:test@localhost/kalend',
    },
    { ...dev, COMMERCIAL_QA_SIMULATION_ENABLED: 'false' },
    { ...dev, QA_COMMUNICATION_COMPANY_IDS: paymentId },
    { ...dev, QA_COMMUNICATION_COMPANY_IDS: `${companyId},invalid` },
  ])(
    'blocks before constructing Prisma in an unauthorized runtime (%j)',
    async (env) => {
      const open = vi.fn();
      await expect(runQaCli(pending, open, vi.fn(), env)).rejects.toThrow(
        'COMMERCIAL_QA_SIMULATION_BLOCKED',
      );
      expect(open).not.toHaveBeenCalled();
    },
  );
  it('check delegates only to the read-only service method', async () => {
    const preflightFromCli = vi.fn().mockResolvedValue({ readOnly: true });
    const simulateFromCli = vi.fn();
    const close = vi.fn();
    await runQaCli(
      ['--company', companyId, '--check'],
      async () => ({ service: { preflightFromCli, simulateFromCli }, close }),
      vi.fn(),
      dev,
    );
    expect(preflightFromCli).toHaveBeenCalledExactlyOnceWith(companyId);
    expect(simulateFromCli).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });
  it.each([
    [],
    [...pending, '--amount', '1'],
    [...pending, '--secret', 'test'],
    [...pending, '--actor', 'SUPER_ADMIN'],
    [...pending, '--company', companyId],
    ['--company', companyId, '--action', 'PAYMENT_APPROVED'],
    ['--company', companyId, '--check', '--action', 'PAYMENT_PENDING'],
    [
      '--company',
      companyId,
      '--action',
      'PAYMENT_PENDING',
      '--payment',
      paymentId,
      '--key',
      'ignored',
    ],
  ])('rejects ambiguous, secret-bearing or incomplete arguments (%j)', (args) =>
    expect(() => parseQaCli(args)).toThrow(),
  );
  it('help never opens a database and errors never echo provider/connection secrets', async () => {
    const open = vi.fn(),
      output = vi.fn();
    await runQaCli(['--help'], open, output, {});
    expect(open).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledWith(expect.stringContaining('--check'));
    expect(
      qaCliFailure(
        new Error('postgresql://sensitive-password@example.invalid'),
      ),
    ).toEqual({
      source: 'QA_SIMULATION',
      execution: 'CLI',
      status: 'BLOCKED',
      code: 'COMMERCIAL_QA_CLI_FAILED',
    });
  });
  it('closes its minimal context even when the service blocks a transition', async () => {
    const close = vi.fn();
    const service = {
      simulateFromCli: vi
        .fn()
        .mockRejectedValue(new Error('QA_COMPANY_NOT_ACTIVE')),
      preflightFromCli: vi.fn(),
    };
    await expect(
      runQaCli(pending, async () => ({ service, close }), vi.fn(), dev),
    ).rejects.toThrow('QA_COMPANY_NOT_ACTIVE');
    expect(close).toHaveBeenCalledTimes(1);
  });
});
