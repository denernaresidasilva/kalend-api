import { randomBytes } from 'node:crypto';
import { CommunicationConfiguration } from './configuration.js';
import { SecretVault } from '../billing/secret-vault.js';
function setup() {
  let row: Record<string, unknown> | null = null;
  const db = {
    globalCommunicationProvider: {
      findUnique: vi.fn(async () => row),
      findMany: vi.fn(async () => (row ? [row] : [])),
      create: vi.fn(async ({ data }) => {
        row = { revision: 1, ...data };
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        if (!row || row.revision !== where.revision) return { count: 0 };
        row = {
          ...row,
          ...Object.fromEntries(
            Object.entries(data).filter(([, v]) => v !== undefined),
          ),
          revision: data.revision ? Number(row.revision) + 1 : row.revision,
        };
        return { count: 1 };
      }),
    },
    globalCommunicationDelivery: { count: vi.fn().mockResolvedValue(0) },
    globalCommunicationLog: { create: vi.fn() },
    $transaction: vi.fn(),
    user: {
      findFirst: vi.fn().mockResolvedValue({
        email: 'admin@example.test',
        phone: '+5511999999999',
      }),
    },
  };
  db.$transaction.mockImplementation((fn) => fn(db));
  const verify = vi.fn().mockResolvedValue(undefined),
    send = vi.fn().mockResolvedValue('id');
  const transports = {
    available: (p: string) => p === 'SMTP',
    get: () => ({ verify, send }),
  };
  return {
    service: new CommunicationConfiguration(
      db as never,
      new SecretVault(),
      transports as never,
    ),
    db,
    verify,
    send,
    row: () => row,
  };
}
const config = {
  host: 'smtp.example.test',
  port: '587',
  secure: 'false',
  username: 'sender',
  fromName: 'Kalend',
  fromEmail: 'sender@example.test',
};
beforeEach(() => {
  vi.stubEnv('GATEWAY_ENCRYPTION_KEY', randomBytes(32).toString('hex'));
  vi.stubEnv('COMMUNICATION_SMTP_HOSTS', config.host);
});
afterEach(() => vi.unstubAllEnvs());
describe('global configuration lifecycle', () => {
  it('is write-only, retains existing secret, tests connection separately and enables only validated settings', async () => {
    const f = setup();
    await f.service.patch(
      'SMTP',
      { config, secrets: { password: 'never-return-me' } },
      'admin',
    );
    const first = f.row()!.credentialsEncrypted;
    const view = JSON.stringify(await f.service.list());
    expect(view).not.toContain('never-return-me');
    expect(view).not.toContain('credentialsEncrypted');
    expect(view).not.toContain(String(first));
    await expect(
      f.service.patch('SMTP', { enabled: true }, 'admin'),
    ).rejects.toThrow('CONNECTION_TEST_REQUIRED');
    await f.service.patch('SMTP', { secrets: { password: '' } }, 'admin');
    expect((await f.service.context('SMTP', false)).secret.password).toBe(
      'never-return-me',
    );
    expect(await f.service.test('SMTP', 'admin')).toEqual({
      connected: true,
      sendTested: false,
    });
    await f.service.patch('SMTP', { enabled: true }, 'admin');
    expect(f.row()!.enabled).toBe(true);
    expect(f.send).not.toHaveBeenCalled();
    await f.service.patch(
      'SMTP',
      { secrets: { password: 'replacement' } },
      'admin',
    );
    expect(f.row()!.enabled).toBe(false);
    expect(f.row()!.lastVerifiedAt).toBeNull();
  });
  it('requires new secrets on environment switch and refuses switch with delivery history', async () => {
    const f = setup();
    await f.service.patch(
      'SMTP',
      { config, secrets: { password: 'old' } },
      'admin',
    );
    await expect(
      f.service.patch(
        'SMTP',
        { environment: 'PRODUCTION', secrets: { password: '' } },
        'admin',
      ),
    ).rejects.toThrow('ENVIRONMENT_REQUIRES_NEW_SECRETS');
    await f.service.patch(
      'SMTP',
      { environment: 'PRODUCTION', secrets: { password: 'new' } },
      'admin',
    );
    expect((await f.service.context('SMTP', false)).secret.password).toBe(
      'new',
    );
    f.db.globalCommunicationDelivery.count.mockResolvedValue(1);
    await expect(
      f.service.patch(
        'SMTP',
        { environment: 'SANDBOX', secrets: { password: 'new' } },
        'admin',
      ),
    ).rejects.toThrow('ENVIRONMENT_HAS_HISTORY');
  });
  it('sanitizes failed connection, disables provider and never declares fake success', async () => {
    const f = setup();
    await f.service.patch(
      'SMTP',
      { config, secrets: { password: 'secret' } },
      'admin',
    );
    f.verify.mockRejectedValue(new Error('secret response'));
    expect(await f.service.test('SMTP', 'admin')).toEqual({
      connected: false,
      sendTested: false,
    });
    expect(f.row()!.lastError).toBe('CONNECTION_FAILED');
    expect(f.row()!.enabled).toBe(false);
  });
  it('restricts test recipient to current admin and rejects arbitrary address fields', async () => {
    const f = setup();
    await f.service.patch(
      'SMTP',
      { config, secrets: { password: 'secret' } },
      'admin',
    );
    await expect(
      f.service.sendTest('SMTP', { to: 'victim@example.test' }, 'admin'),
    ).rejects.toThrow();
    expect(await f.service.sendTest('SMTP', {}, 'admin')).toEqual({
      accepted: true,
      delivered: false,
    });
    expect(f.send).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ to: 'admin@example.test' }),
    );
  });
});
