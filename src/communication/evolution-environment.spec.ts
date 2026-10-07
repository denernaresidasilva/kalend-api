import { readFileSync } from 'node:fs';
import { ServiceUnavailableException, Logger } from '@nestjs/common';
import { EvolutionClient } from './evolution-client.js';
import { EvolutionService, GLOBAL_EVOLUTION } from './evolution.js';
import {
  evolutionConfiguration,
  evolutionGlobalName,
  evolutionInstanceName,
} from './evolution-environment.js';
import {
  evolutionPreflight,
  compatibleWithGlobalMigration,
  compatibleWithEnvironmentMigration,
} from './evolution-preflight.js';
import { evolutionDatabase } from '../../test/support/evolution-database.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SecretVault } from '../billing/secret-vault.js';
const id = '11111111-1111-4111-8111-111111111111';
const qr = readFileSync(
  new URL('../../test/fixtures/evolution-qr.txt', import.meta.url),
  'utf8',
).trim();
const renewed = readFileSync(
  new URL('../../test/fixtures/evolution-qr-renewed.txt', import.meta.url),
  'utf8',
).trim();
function setup() {
  const f = evolutionDatabase();
  let code = qr;
  let state = 'close';
  const client = {
    fetchInstances: vi.fn(async () => ({ integration: 'WHATSAPP-BAILEYS' })),
    createInstance: vi.fn(async () => ({})),
    setWebhook: vi.fn(
      async (_name: string, _url: string, _token: string) => ({}),
    ),
    fetchConnectionState: vi.fn(async () => ({ instance: { state } })),
    connectInstance: vi.fn(async () => {
      state = 'connecting';
      return { base64: code };
    }),
    restartInstance: vi.fn(async () => {
      code = renewed;
      return {};
    }),
    deleteInstance: vi.fn(async () => ({})),
    logoutInstance: vi.fn(async () => ({})),
  };
  const service = () =>
    new EvolutionService(
      f.db as unknown as PrismaService,
      client as unknown as EvolutionClient,
      new SecretVault(),
    );
  return {
    f,
    client,
    service,
    setState: (value: string) => {
      state = value;
    },
    setCode: (value: string) => {
      code = value;
    },
  };
}
describe('Evolution deployment isolation and recovery', () => {
  beforeEach(() => {
    vi.stubEnv('EVOLUTION_WEBHOOK_BASE_URL', 'https://api-dev.kalend.tech');
    vi.stubEnv('GATEWAY_ENCRYPTION_KEY', 'a'.repeat(64));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  it.each([
    ['https://api-dev.kalend.tech', 'DEV'],
    ['https://api.kalend.tech', 'PRODUCTION'],
  ])('binds %s to %s without NODE_ENV fallback', async (url, expected) => {
    vi.stubEnv('EVOLUTION_WEBHOOK_BASE_URL', url);
    vi.stubEnv('NODE_ENV', 'production');
    expect(evolutionConfiguration().environment).toBe(expected);
    const x = setup();
    await x.service().prepare(GLOBAL_EVOLUTION);
    expect(x.client.setWebhook.mock.calls[0][1]).toBe(
      url +
        '/webhooks/communication/evolution/global/' +
        [...x.f.rows.values()][0].id,
    );
  });
  it('fails explicitly without URL, before any provider request', async () => {
    vi.stubEnv('EVOLUTION_WEBHOOK_BASE_URL', '');
    const x = setup();
    await expect(x.service().prepare(id)).rejects.toThrow(
      ServiceUnavailableException,
    );
    try {
      await x.service().prepare(id);
    } catch (e) {
      expect((e as ServiceUnavailableException).getResponse()).toMatchObject({
        errorCode: 'EVOLUTION_WEBHOOK_BASE_URL_REQUIRED',
      });
    }
    expect(x.client.fetchInstances).not.toHaveBeenCalled();
    expect(x.client.createInstance).not.toHaveBeenCalled();
    expect(x.client.setWebhook).not.toHaveBeenCalled();
  });
  it('refuses a DEV billing deployment configured with production callback', () => {
    vi.stubEnv('EVOLUTION_WEBHOOK_BASE_URL', 'https://api.kalend.tech');
    vi.stubEnv('BILLING_PUBLIC_API_URL', 'https://api-dev.kalend.tech');
    expect(() => evolutionConfiguration()).toThrow(
      'EVOLUTION_ENVIRONMENT_MISMATCH',
    );
  });
  it.each([
    [
      'https://api-dev.kalend.tech',
      'postgresql://test:test@localhost/production',
    ],
    ['https://api.kalend.tech', 'postgresql://test:test@localhost/kalend_dev'],
  ])('refuses database/environment mismatch for %s', (url, database) => {
    vi.stubEnv('EVOLUTION_WEBHOOK_BASE_URL', url);
    vi.stubEnv('DATABASE_URL', database);
    expect(() => evolutionConfiguration()).toThrow(
      'EVOLUTION_ENVIRONMENT_MISMATCH',
    );
  });
  it('generates disjoint deterministic global/company namespaces for the same UUID', () => {
    expect(evolutionGlobalName('DEV')).toBe('kalend_dev_global');
    expect(evolutionGlobalName('PRODUCTION')).toBe('kalend_global');
    expect(evolutionInstanceName(id, 'DEV')).not.toBe(
      evolutionInstanceName(id, 'PRODUCTION'),
    );
    expect(evolutionInstanceName(id, 'DEV')).toBe(
      'kalend_dev_11111111111141118111111111111111',
    );
  });
  it('rebinds an unassigned legacy DEV row without touching its unprefixed remote instance', async () => {
    const x = setup();
    const old = await x.f.db.evolutionConnection.upsert({
      where: { companyId: id },
      create: {
        companyId: id,
        instanceName: evolutionInstanceName(id),
        prepared: true,
        phone: '+5511999999999',
      },
    });
    await x.service().prepare(id);
    expect(x.f.rows.get(old.id)).toMatchObject({
      environment: 'DEV',
      instanceName: evolutionInstanceName(id, 'DEV'),
    });
    expect(x.client.fetchInstances).toHaveBeenCalledWith(
      evolutionInstanceName(id, 'DEV'),
    );
    expect(x.client.logoutInstance).not.toHaveBeenCalled();
    expect(x.client.deleteInstance).not.toHaveBeenCalled();
    expect(x.client.setWebhook.mock.calls[0][1]).toMatch(
      /^https:\/\/api-dev\.kalend\.tech\//,
    );
  });
  it('refuses a connection explicitly bound to the other environment, including get/logout/delete', async () => {
    const x = setup();
    await x.f.db.evolutionConnection.upsert({
      where: { companyId: id },
      create: {
        companyId: id,
        environment: 'PRODUCTION',
        instanceName: evolutionInstanceName(id),
      },
    });
    for (const method of ['prepare', 'get', 'logout', 'remove'] as const)
      await expect(x.service()[method](id)).rejects.toThrow(
        'EVOLUTION_ENVIRONMENT_MISMATCH',
      );
    expect(x.client.fetchConnectionState).not.toHaveBeenCalled();
    expect(x.client.deleteInstance).not.toHaveBeenCalled();
  });
  it('shares expiry between replicas and restarts an expired pending QR without create/delete', async () => {
    vi.useFakeTimers();
    const x = setup();
    const first = await x.service().prepare(id);
    vi.advanceTimersByTime(10000);
    const second = await x.service().get(id);
    expect(second.qrExpiresAt).toBe(first.qrExpiresAt);
    vi.advanceTimersByTime(60000);
    expect((await x.service().get(id)).qrCode).toBeNull();
    expect(x.client.restartInstance).not.toHaveBeenCalled();
    const recovered = await x.service().connect(id);
    expect(recovered.qrCode).toBe(renewed);
    expect(x.client.restartInstance).toHaveBeenCalledWith(
      evolutionInstanceName(id, 'DEV'),
    );
    expect(x.client.createInstance).not.toHaveBeenCalled();
    expect(x.client.deleteInstance).not.toHaveBeenCalled();
    expect(x.f.rows.size).toBe(1);
    expect(JSON.stringify(x.f.rows.get([...x.f.rows.keys()][0]))).not.toContain(
      qr,
    );
  });
  it('uses connect without restart when Evolution closes an attempt', async () => {
    vi.useFakeTimers();
    const x = setup();
    await x.service().prepare(id);
    vi.advanceTimersByTime(70000);
    x.setState('close');
    x.setCode(renewed);
    expect((await x.service().get(id)).status).toBe('DISCONNECTED');
    expect((await x.service().connect(id)).qrCode).toBe(renewed);
    expect(x.client.restartInstance).not.toHaveBeenCalled();
    expect(x.client.createInstance).not.toHaveBeenCalled();
  });
  it('never restarts through reads from multiple replicas while waiting for a new QR', async () => {
    vi.useFakeTimers();
    const x = setup();
    x.client.restartInstance.mockImplementation(async () => ({}));
    await x.service().prepare(id);
    vi.advanceTimersByTime(70000);
    await x.service().get(id);
    await x.service().get(id);
    expect(x.client.restartInstance).not.toHaveBeenCalled();
    expect(x.client.createInstance).not.toHaveBeenCalled();
  });
  it('never logs or returns QR, token, credentials or request headers', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    const x = setup();
    const result = await x.service().prepare(id);
    const token = x.client.setWebhook.mock.calls[0][2];
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toMatch(
      /codeFingerprint|webhookSecret|instanceName/,
    );
    expect(JSON.stringify([...log.mock.calls, ...warn.mock.calls])).not.toMatch(
      /apikey|Authorization|credential|data:image|x-kalend-evolution-token/,
    );
    expect(
      JSON.stringify([...log.mock.calls, ...warn.mock.calls]),
    ).not.toContain(token);
  });
});
describe('Evolution migration preflight data checks', () => {
  const company = {
    id: 'connection',
    companyId: id,
    globalKey: null,
    instanceName: evolutionInstanceName(id),
  };
  it('accepts legacy company/global rows and reports DEV rebinding without changing input', () => {
    const input = [
      company,
      {
        id: 'global',
        companyId: null,
        globalKey: 'GLOBAL',
        instanceName: 'kalend_global',
      },
    ];
    const before = JSON.stringify(input);
    const result = evolutionPreflight(input, 'DEV');
    expect(result.compatible).toBe(true);
    expect(result.legacyDevRebinding).toBe(2);
    expect(JSON.stringify(input)).toBe(before);
  });
  it('detects invalid CHECK data, orphan company, duplicates and foreign environment before deploy', () => {
    const rows = [
      { ...company, companyExists: false },
      { ...company, id: 'duplicate' },
      {
        ...company,
        id: 'wrong',
        environment: 'DEV' as const,
        instanceName: 'bad',
      },
    ];
    const result = evolutionPreflight(rows, 'PRODUCTION');
    expect(result.compatible).toBe(false);
    expect(JSON.stringify(result)).toMatch(
      /COMPANY_FOREIGN_KEY_FAILED|DUPLICATE_COMPANY|CONNECTION_ENVIRONMENT_MISMATCH|ENVIRONMENT_MIGRATION_CHECK_FAILED/,
    );
  });
  it('mirrors both checks including NULL contexts and rejects DEV names before migration 2', () => {
    expect(
      compatibleWithGlobalMigration({
        id: 'empty',
        companyId: null,
        globalKey: null,
        instanceName: 'name',
      }),
    ).toBe(false);
    const dev = {
      ...company,
      environment: 'DEV' as const,
      instanceName: evolutionInstanceName(id, 'DEV'),
    };
    expect(compatibleWithGlobalMigration(dev)).toBe(false);
    expect(compatibleWithEnvironmentMigration(dev)).toBe(true);
    expect(evolutionPreflight([dev], 'DEV', false).compatible).toBe(false);
    expect(evolutionPreflight([dev], 'DEV', true).compatible).toBe(true);
  });
});
