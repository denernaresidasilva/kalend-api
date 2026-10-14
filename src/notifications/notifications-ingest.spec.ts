import { NotificationsService } from './notifications.service.js';

const companyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('notification outbox ingestion scope', () => {
  it('uses the QA company filter in the row-locking query', async () => {
    const queryRaw = vi.fn()
      .mockResolvedValueOnce([{ now: new Date('2026-10-13T00:00:00Z') }])
      .mockResolvedValueOnce([]);
    const tx = { $queryRaw: queryRaw };
    const db = {
      $transaction: vi.fn((callback: (transaction: typeof tx) => unknown) => callback(tx)),
    };
    const service = new NotificationsService(db as never);
    await expect(service.ingest({ companyIds: [companyId], limit: 5 })).resolves.toEqual({
      processed: 0,
      created: 0,
    });
    const selection = queryRaw.mock.calls[1][0] as { sql: string; values: unknown[] };
    expect(selection.sql).toContain('"companyId" IN');
    expect(selection.sql).toContain('LIMIT');
    expect(selection.values).toContain(companyId);
    expect(selection.values).toContain(5);
    expect(selection.values).toContain('QA_SIMULATION%');
    expect(selection.sql).toContain('"businessKey" NOT LIKE');
  });

  it('requires explicit QA mode and rejects unauthorized companies before querying', async () => {
    vi.stubEnv('EVOLUTION_WEBHOOK_BASE_URL', 'https://api-dev.kalend.tech');
    vi.stubEnv('DATABASE_URL', 'postgresql://test:unused@localhost/kalend_dev');
    vi.stubEnv('BILLING_PUBLIC_API_URL', 'https://api-dev.kalend.tech');
    vi.stubEnv('QA_COMMUNICATION_ENABLED', 'true');
    vi.stubEnv('QA_COMMUNICATION_COMPANY_IDS', companyId);
    const transaction = vi.fn();
    try {
      await expect(new NotificationsService({ $transaction: transaction } as never)
        .ingest({ qaMode: true, companyIds: ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'] }))
        .rejects.toThrow('QA_COMMUNICATION_SCOPE_MISMATCH');
      expect(transaction).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });

  it('does no query when the QA company allowlist is empty', async () => {
    const transaction = vi.fn();
    const service = new NotificationsService({ $transaction: transaction } as never);
    await expect(service.ingest({ companyIds: [], limit: 5 })).resolves.toEqual({
      processed: 0,
      created: 0,
    });
    expect(transaction).not.toHaveBeenCalled();
  });
});
