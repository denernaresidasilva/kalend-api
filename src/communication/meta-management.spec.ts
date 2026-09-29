import { MetaTemplates, metaTemplate } from './meta.js';
import { jsonRequest } from './network.js';
import { SecretVault } from '../billing/secret-vault.js';
import { randomBytes } from 'node:crypto';
vi.mock('./network.js', () => ({ jsonRequest: vi.fn() }));
function setup() {
  const vault = new SecretVault();
  const row = {
    environment: 'SANDBOX',
    config: {
      graphVersion: 'v25.0',
      businessAccountId: '123',
      phoneNumberId: '456',
    },
    credentialsEncrypted: vault.encrypt(
      JSON.stringify({ accessToken: 'private' }),
      'communication:GLOBAL:META:SANDBOX:credentials',
    ),
  };
  const db = {
    globalCommunicationProvider: { findUnique: vi.fn().mockResolvedValue(row) },
    globalCommunicationMetaTemplate: { upsert: vi.fn() },
    globalCommunicationLog: { create: vi.fn() },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation((fn) => fn(db));
  return { service: new MetaTemplates(db as never, vault), db };
}
beforeEach(() => {
  vi.stubEnv('COMMUNICATION_META_GRAPH_VERSION', 'v25.0');
  vi.stubEnv('GATEWAY_ENCRYPTION_KEY', randomBytes(32).toString('hex'));
});
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});
describe('official Meta template administration', () => {
  it('persists only remote status and account/environment from configuration', async () => {
    const { service, db } = setup();
    vi.mocked(jsonRequest).mockResolvedValue({
      data: [
        {
          id: '789',
          name: 'hello',
          language: 'pt_BR',
          status: 'PENDING',
          category: 'UTILITY',
          components: [{ type: 'BODY', text: 'Olá' }],
        },
      ],
    });
    expect(await service.sync({}, 'admin')).toEqual({ synced: 1, after: null });
    expect(db.globalCommunicationMetaTemplate.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          environment: 'SANDBOX',
          businessAccountId: '123',
          status: 'PENDING',
        }),
      }),
    );
  });
  it('submits static BODY only and returns syncRequired without local approval', async () => {
    const { service, db } = setup();
    vi.mocked(jsonRequest).mockResolvedValue({ id: '789', status: 'PENDING' });
    expect(
      await service.create(
        { name: 'hello', language: 'pt_BR', category: 'UTILITY', text: 'Olá' },
        'admin',
      ),
    ).toEqual({ externalId: '789', syncRequired: true });
    expect(db.globalCommunicationMetaTemplate.upsert).not.toHaveBeenCalled();
    expect(vi.mocked(jsonRequest).mock.calls[0][2]).toEqual({
      name: 'hello',
      language: 'pt_BR',
      category: 'UTILITY',
      components: [{ type: 'BODY', text: 'Olá' }],
    });
  });
  it('rejects local status, arbitrary components and unsupported submission variables', async () => {
    const { service } = setup();
    for (const extra of [
      { status: 'APPROVED' },
      { components: [] },
      { text: 'Olá {{1}}' },
    ])
      await expect(
        service.create(
          {
            name: 'hello',
            language: 'pt_BR',
            category: 'UTILITY',
            text: 'Olá',
            ...extra,
          },
          'admin',
        ),
      ).rejects.toThrow();
    expect(jsonRequest).not.toHaveBeenCalled();
  });
  it('does not retry an uncertain submission or expose its response', async () => {
    const { service } = setup();
    vi.mocked(jsonRequest).mockRejectedValue(new Error('private token'));
    await expect(
      service.create(
        { name: 'hello', language: 'pt_BR', category: 'UTILITY', text: 'Olá' },
        'admin',
      ),
    ).rejects.toThrow('META_SUBMISSION_FAILED_OR_UNCERTAIN_SYNC_BEFORE_RETRY');
    expect(jsonRequest).toHaveBeenCalledTimes(1);
  });
  it('rejects missing remote status instead of inventing APPROVED', () =>
    expect(() =>
      metaTemplate({
        id: '789',
        name: 'hello',
        language: 'pt_BR',
        category: 'UTILITY',
        components: [],
      }),
    ).toThrow());
});
