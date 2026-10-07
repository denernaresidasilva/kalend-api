import { CommunicationConfiguration } from './configuration.js';
import { EvolutionTransport } from './transports.js';
import { EvolutionFailure } from './evolution-client.js';
import { EvolutionService, GLOBAL_EVOLUTION } from './evolution.js';

describe('central GLOBAL provider resolution', () => {
  function fixture(rows: Record<string, unknown>[]) {
    const db = {
      globalCommunicationProvider: {
        findUnique: vi.fn(
          async ({ where }) =>
            rows.find((r) => r.provider === where.provider) ?? null,
        ),
      },
    };
    const service = new CommunicationConfiguration(
      db as never,
      {} as never,
      { available: () => true } as never,
    );
    return { db, service };
  }
  it('uses active SMTP or Gmail irrespective of template provider and excludes COMPANY', async () => {
    const rows = [
      {
        provider: 'SMTP',
        scope: 'GLOBAL',
        enabled: true,
        lastTestStatus: 'SUCCESS',
      },
      { provider: 'GMAIL', scope: 'GLOBAL', enabled: false },
    ];
    const f = fixture(rows);
    expect(await f.service.resolveProvider('EMAIL')).toBe('SMTP');
    rows[0].enabled = false;
    rows[1].enabled = true;
    expect(await f.service.resolveProvider('EMAIL')).toBe('GMAIL');
    rows[1].scope = 'COMPANY';
    expect(await f.service.resolveProvider('EMAIL')).toBeNull();
  });
  it('does not send through unvalidated SMTP; inactive channels remain unavailable', async () => {
    const f = fixture([
      {
        provider: 'SMTP',
        scope: 'GLOBAL',
        enabled: true,
        lastTestStatus: 'ERROR',
      },
    ]);
    expect(await f.service.resolveProvider('EMAIL')).toBeNull();
    expect(await f.service.resolveProvider('WHATSAPP')).toBeNull();
    expect(await f.service.resolveProvider('PUSH')).toBeNull();
  });
});

describe('GLOBAL WhatsApp test and enable path', () => {
  function fixture() {
    const row = {
      provider: 'EVOLUTION',
      scope: 'GLOBAL',
      enabled: true,
      revision: 1,
      environment: 'PRODUCTION',
    };
    const db = {
      user: {
        findFirst: vi.fn(async () => ({
          phone: '5511999999999',
          email: 'admin@example.test',
        })),
      },
      evolutionConnection: {
        findUnique: vi.fn(async () => ({
          prepared: true,
          status: 'CONNECTED',
        })),
      },
      globalCommunicationProvider: {
        findUnique: vi.fn(async () => row),
        findMany: vi.fn(async () => [row]),
        update: vi.fn(async ({ data }) => Object.assign(row, data)),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      globalCommunicationLog: { create: vi.fn() },
      $transaction: vi.fn(),
    };
    db.$transaction.mockImplementation((work) => work(db));
    const evolution = {
      get: vi.fn(async () => ({ status: 'CONNECTED' })),
      globalConnection: vi.fn(async () => ({
        prepared: true,
        status: 'CONNECTED',
        instanceName: 'kalend_dev_global',
      })),
      sendGlobalTextMessage: vi.fn(async () => ({ messageId: 'accepted' })),
    };
    const adapter = new EvolutionTransport(evolution as never);
    const service = new CommunicationConfiguration(
      db as never,
      {} as never,
      { available: () => true, get: () => adapter } as never,
      evolution as never,
    );
    return { db, row, evolution, service };
  }
  beforeEach(() => vi.stubEnv('EVOLUTION_API_KEY', 'test-only'));
  afterEach(() => vi.unstubAllEnvs());
  it('uses authenticated Super Admin, accepts the saved Evolution phone format and dispatches through GLOBAL adapter', async () => {
    const f = fixture();
    expect(await f.service.sendTest('EVOLUTION', {}, 'admin')).toEqual({
      accepted: true,
      delivered: false,
    });
    expect(f.db.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'admin', isSuperAdmin: true, isActive: true },
      }),
    );
    expect(f.evolution.get).toHaveBeenCalledWith(GLOBAL_EVOLUTION);
    expect(f.evolution.sendGlobalTextMessage).toHaveBeenCalledWith(
      'admin',
      '✅ Teste de WhatsApp do Kalend realizado com sucesso.',
    );
  });
  it('allows an explicit Super Admin test number without modifying the stored profile or selecting a COMPANY connection', async () => {
    const f = fixture();
    f.db.user.findFirst.mockResolvedValue({
      phone: '',
      email: 'admin@example.test',
    });
    expect(
      await f.service.sendTest(
        'EVOLUTION',
        { number: '+55 (11) 99999-9999' },
        'admin',
      ),
    ).toEqual({ accepted: true, delivered: false });
    expect(f.evolution.sendGlobalTextMessage).toHaveBeenCalledWith(
      'admin',
      '✅ Teste de WhatsApp do Kalend realizado com sucesso.',
      '5511999999999',
    );
    await expect(
      f.service.sendTest('EVOLUTION', { number: 'invalid' }, 'admin'),
    ).rejects.toMatchObject({
      response: { errorCode: 'TEST_RECIPIENT_UNAVAILABLE' },
    });
  });
  it('rejects disabled provider before contacting Evolution', async () => {
    const f = fixture();
    f.row.enabled = false;
    await expect(
      f.service.sendTest('EVOLUTION', {}, 'admin'),
    ).rejects.toMatchObject({
      response: { errorCode: 'GLOBAL_PROVIDER_DISABLED' },
    });
    expect(f.evolution.sendGlobalTextMessage).not.toHaveBeenCalled();
  });
  it('preserves useful sanitized Evolution errors through adapter and API', async () => {
    const f = fixture();
    f.evolution.sendGlobalTextMessage.mockRejectedValue(
      new EvolutionFailure('CONNECTION_NOT_OPEN'),
    );
    await expect(
      f.service.sendTest('EVOLUTION', {}, 'admin'),
    ).rejects.toMatchObject({
      response: {
        errorCode: 'CONNECTION_NOT_OPEN',
        message: expect.stringContaining('sessão'),
      },
    });
  });
  it('checks authoritative GLOBAL connection when enabling; COMPANY is never consulted', async () => {
    const f = fixture();
    await f.service.patch('EVOLUTION', { enabled: true }, 'admin');
    expect(f.evolution.get).toHaveBeenCalledWith(GLOBAL_EVOLUTION);
    expect(f.db.globalCommunicationProvider.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { provider: 'EVOLUTION' } }),
    );
    f.evolution.get.mockResolvedValue({ status: 'DISCONNECTED' });
    await expect(
      f.service.patch('EVOLUTION', { enabled: true }, 'admin'),
    ).rejects.toMatchObject({ response: { errorCode: 'CONNECTION_NOT_OPEN' } });
  });
});

describe('email provider exclusivity', () => {
  it.each(['SMTP', 'GMAIL'] as const)(
    'activating %s disables the other email provider in one serializable transaction',
    async (provider) => {
      vi.stubEnv('COMMUNICATION_SMTP_HOSTS', 'smtp.example.test');
      const rows: Record<string, Record<string, unknown>> = {
        SMTP: {
          provider: 'SMTP',
          scope: 'GLOBAL',
          environment: 'SANDBOX',
          revision: 1,
          status: 'CONNECTED',
          lastTestStatus: 'SUCCESS',
          enabled: provider !== 'SMTP',
          config: {
            host: 'smtp.example.test',
            port: '587',
            secure: 'false',
            username: 'sender',
            fromName: 'Kalend',
            fromEmail: 'sender@example.test',
          },
          credentialsEncrypted: JSON.stringify({ password: 'test-only' }),
        },
        GMAIL: {
          provider: 'GMAIL',
          scope: 'GLOBAL',
          environment: 'SANDBOX',
          revision: 1,
          status: 'CONNECTED',
          enabled: provider !== 'GMAIL',
          config: {
            clientId: 'test.apps.googleusercontent.com',
            fromEmail: 'sender@example.test',
          },
          credentialsEncrypted: JSON.stringify({
            clientSecret: 'test-only',
            refreshToken: 'test-only',
          }),
        },
      };
      const db = {
        globalCommunicationProvider: {
          findUnique: vi.fn(async ({ where }) => rows[where.provider]),
          findMany: vi.fn(async () => Object.values(rows)),
          updateMany: vi.fn(async ({ where, data }) => {
            const row = rows[where.provider];
            if (
              (where.enabled !== undefined && row.enabled !== where.enabled) ||
              (where.revision !== undefined && row.revision !== where.revision)
            )
              return { count: 0 };
            Object.assign(
              row,
              Object.fromEntries(
                Object.entries(data).filter(
                  ([, value]) =>
                    value !== undefined && typeof value !== 'object',
                ),
              ),
            );
            row.revision = Number(row.revision) + 1;
            return { count: 1 };
          }),
        },
        globalCommunicationDelivery: { count: vi.fn(async () => 0) },
        globalCommunicationLog: { create: vi.fn() },
        $transaction: vi.fn(),
      };
      db.$transaction.mockImplementation((work) => work(db));
      const service = new CommunicationConfiguration(
        db as never,
        {
          decrypt: (value: string) => value,
          encrypt: (value: string) => value,
        } as never,
        { available: () => true } as never,
      );
      await service.patch(provider, { enabled: true }, 'admin');
      expect(
        Object.values(rows)
          .filter((row) => row.enabled)
          .map((row) => row.provider),
      ).toEqual([provider]);
      expect(await service.resolveProvider('EMAIL')).toBe(provider);
      expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: 'Serializable',
      });
      vi.unstubAllEnvs();
    },
  );
});

describe('explicit GLOBAL test destination authorization', () => {
  it('requires a live Super Admin even when an owner tries to supply a test number directly', async () => {
    const db = { user: { findFirst: vi.fn(async () => null) } };
    const service = new EvolutionService(db as never, {} as never, {} as never);
    await expect(
      service.sendGlobalTextMessage('owner', 'test', '5511999999999'),
    ).rejects.toMatchObject({ code: 'GLOBAL_RECIPIENT_UNAVAILABLE' });
    expect(db.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'owner',
          isSuperAdmin: true,
          isActive: true,
        }),
      }),
    );
  });
});
