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
