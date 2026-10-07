import { readFileSync } from 'node:fs';
import { Logger } from '@nestjs/common';
import { EvolutionService, GLOBAL_EVOLUTION } from './evolution.js';
import { EvolutionClient, evolutionPhone } from './evolution-client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SecretVault } from '../billing/secret-vault.js';
import { evolutionDatabase } from '../../test/support/evolution-database.js';
const qr = readFileSync(
  new URL('../../test/fixtures/evolution-qr.txt', import.meta.url),
  'utf8',
).trim();
const renewed = readFileSync(
  new URL('../../test/fixtures/evolution-qr-renewed.txt', import.meta.url),
  'utf8',
).trim();
const logEntries: unknown[] = [];
const company = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
function fixture() {
  const f = evolutionDatabase();
  let state = 'close';
  const client = {
    fetchInstances: vi.fn(async () => ({ integration: 'WHATSAPP-BAILEYS' })),
    createInstance: vi.fn(async () => ({})),
    setWebhook: vi.fn(async (_n: string, _u: string, _t: string) => ({})),
    fetchConnectionState: vi.fn(async () => ({ instance: { state } })),
    connectInstance: vi.fn(
      async (_n: string, _phone?: string): Promise<unknown> => {
        state = 'connecting';
        return {};
      },
    ),
    logoutInstance: vi.fn(async () => {
      state = 'close';
      return {};
    }),
    restartInstance: vi.fn(async () => ({})),
    deleteInstance: vi.fn(async () => ({})),
  };
  const service = () =>
    new EvolutionService(
      f.db as unknown as PrismaService,
      client as unknown as EvolutionClient,
      new SecretVault(),
    );
  const row = () => [...f.rows.values()][0];
  const hook = async (
    event: string,
    data: unknown,
    date = new Date(),
    instance = row().instanceName,
    token = client.setWebhook.mock.calls.at(-1)![2],
  ) =>
    service().webhook(
      row().id,
      token,
      {
        instance,
        event,
        date_time: date.toISOString(),
        data,
        apikey: 'must-never-escape',
      },
      row().companyId ? 'COMPANY' : 'GLOBAL',
    );
  return {
    ...f,
    client,
    service,
    row,
    hook,
    state: (s: string) => {
      state = s;
    },
  };
}
describe('durable Evolution session snapshots and concurrent callbacks', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-07T15:00:00.000Z'));
    vi.stubEnv('EVOLUTION_WEBHOOK_BASE_URL', 'https://api-dev.kalend.tech');
    vi.stubEnv('GATEWAY_ENCRYPTION_KEY', 'a'.repeat(64));
    logEntries.length = 0;
    vi.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
      logEntries.push(message);
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  it('serves a valid scannable QR received only by webhook from another service replica', async () => {
    const f = fixture();
    await f.service().prepare(GLOBAL_EVOLUTION);
    await f.hook('qrcode.updated', {
      qrcode: { base64: qr, code: 'not-a-browser-image', pairingCode: null },
    });
    f.client.connectInstance.mockRejectedValue(
      new Error('must not request another QR'),
    );
    const dto = await f.service().get(GLOBAL_EVOLUTION);
    expect(dto.qrCode).toBe(qr);
    expect(dto.status).toBe('QR_AVAILABLE');
    expect(f.client.connectInstance).toHaveBeenCalledOnce();
    expect(f.row().codeEncrypted).not.toContain(qr);
    expect(JSON.stringify(dto)).not.toMatch(
      /must-never-escape|webhookSecret|codeEncrypted|pairingPhone|instanceName/,
    );
    expect(
      Buffer.from(qr.split(',')[1], 'base64').readUInt32BE(16),
    ).toBeGreaterThan(100);
  });
  it('accepts QR and open callbacks while prepare holds a lease and stale HTTP QR cannot undo open', async () => {
    const f = fixture();
    let finish!: (v: unknown) => void;
    f.client.connectInstance.mockImplementation(async () => {
      f.state('connecting');
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const pending = f.service().prepare(GLOBAL_EVOLUTION);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(f.row().leaseId).not.toBeNull();
    expect(await f.hook('qrcode.updated', { qrcode: { base64: qr } })).toEqual({
      accepted: true,
    });
    vi.advanceTimersByTime(1);
    expect(await f.hook('connection.update', { state: 'open' })).toEqual({
      accepted: true,
    });
    finish({ base64: renewed });
    expect(await pending).toMatchObject({ status: 'CONNECTED', qrCode: null });
    expect(f.row().codeEncrypted).toBeNull();
  });
  it('coalesces two QR requests without duplicates, logout or restart', async () => {
    const f = fixture();
    let finish!: (v: unknown) => void;
    f.client.connectInstance.mockImplementation(async () => {
      f.state('connecting');
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const first = f.service().connect(GLOBAL_EVOLUTION);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(await f.service().connect(GLOBAL_EVOLUTION)).toMatchObject({
      operationPending: true,
    });
    finish({ base64: qr });
    await first;
    await f.service().connect(GLOBAL_EVOLUTION);
    expect(f.client.connectInstance).toHaveBeenCalledOnce();
    expect(f.client.logoutInstance).not.toHaveBeenCalled();
    expect(f.client.restartInstance).not.toHaveBeenCalled();
    expect(f.rows.size).toBe(1);
  });
  it('duplicate and older QR events never extend expiry or replace the newest image', async () => {
    const f = fixture();
    await f.service().prepare(company);
    const date = new Date();
    await f.hook('qrcode.updated', { qrcode: { base64: qr } }, date);
    const expiry = f.row().codeExpiresAt!.getTime();
    vi.advanceTimersByTime(1000);
    await f.hook('qrcode.updated', { qrcode: { base64: qr } });
    expect(f.row().codeExpiresAt!.getTime()).toBe(expiry);
    vi.advanceTimersByTime(1000);
    await f.hook('qrcode.updated', { qrcode: { base64: renewed } });
    const version = f.row().version;
    await f.hook('qrcode.updated', { qrcode: { base64: qr } }, date);
    expect(f.row().version).toBe(version);
    expect((await f.service().get(company)).qrCode).toBe(renewed);
  });
  it('QR and open at the same timestamp are distinct events, and delayed connecting cannot undo open', async () => {
    const f = fixture();
    await f.service().prepare(company);
    const date = new Date();
    await f.hook('qrcode.updated', { qrcode: { base64: qr } }, date);
    await f.hook('connection.update', { state: 'open' }, date);
    await f.hook(
      'connection.update',
      { state: 'connecting' },
      new Date(date.getTime() - 1),
    );
    expect(f.row().status).toBe('CONNECTED');
    expect(f.row().codeEncrypted).toBeNull();
  });
  it('terminal close/401 at the same timestamp as open is processed and wins a tie', async () => {
    const f = fixture();
    await f.service().prepare(company);
    const date = new Date();
    await f.hook('connection.update', { state: 'open' }, date);
    await f.hook(
      'connection.update',
      { state: 'close', statusReason: 401 },
      date,
    );
    await f.hook('connection.update', { state: 'open' }, date);
    expect(f.row().status).toBe('DISCONNECTED');
    expect(f.row().disconnectReason).toBe(401);
  });
  it('a later connecting event cannot mask logout without an explicit new attempt', async () => {
    const f = fixture();
    await f.service().prepare(company);
    await f.hook('connection.update', { state: 'close', statusReason: 401 });
    vi.advanceTimersByTime(1);
    await f.hook('connection.update', { state: 'connecting' });
    expect(f.row().status).toBe('DISCONNECTED');
    expect(f.row().lastError).toBe('WHATSAPP_LOGGED_OUT');
  });
  it('opening an existing PHONE attempt does not switch to QR or log out', async () => {
    const f = fixture();
    await f.service().connect(company, '5512996055129');
    f.row().pairingPhoneEncrypted = null; // Existing pre-migration attempt has no saved phone.
    await f.service().prepare(company);
    expect(f.client.logoutInstance).not.toHaveBeenCalled();
    expect(f.client.connectInstance).toHaveBeenCalledOnce();
  });
  it('a pending mode switch does not log out a session which opened before cancellation', async () => {
    const f = fixture();
    await f.service().prepare(company);
    f.client.fetchConnectionState.mockResolvedValueOnce({
      instance: { state: 'connecting' },
    });
    f.client.fetchConnectionState.mockImplementationOnce(async () => {
      f.state('open');
      return { instance: { state: 'open' } };
    });
    expect((await f.service().connect(company, '5512996055129')).status).toBe(
      'CONNECTED',
    );
    expect(f.client.logoutInstance).not.toHaveBeenCalled();
  });
  it('open emitted during an explicit logout cannot undo the confirmed logout', async () => {
    const f = fixture();
    await f.service().prepare(company);
    f.client.logoutInstance.mockImplementation(async () => {
      vi.advanceTimersByTime(1);
      await f.hook('connection.update', { state: 'open' });
      f.state('close');
      return {};
    });
    expect((await f.service().logout(company)).status).toBe('DISCONNECTED');
    expect(f.row().lastError).toBe('WHATSAPP_LOGGED_OUT');
    expect(f.row().codeEncrypted).toBeNull();
  });
  it('company preparation failure leaves a durable retry, never requests a QR, and configuration failure never rejects the detached task', async () => {
    const f = fixture();
    f.client.setWebhook.mockRejectedValueOnce(
      new Error('private provider detail'),
    );
    await f.service().prepareAfterCompanyCreated(company);
    expect(f.row().provisionRequested).toBe(true);
    expect(f.client.connectInstance).not.toHaveBeenCalled();
    await f.service().maintenance();
    expect(f.row().prepared).toBe(true);
    expect(f.row().provisionRequested).toBe(false);
    vi.stubEnv('EVOLUTION_WEBHOOK_BASE_URL', '');
    await expect(
      f.service().prepareAfterCompanyCreated(other),
    ).resolves.toBeUndefined();
  });
  it('cleanup never changes snapshots explicitly assigned to another deployment', async () => {
    const f = fixture();
    await f.service().prepare(company);
    await f.hook('qrcode.updated', { qrcode: { base64: qr } });
    const encrypted = f.row().codeEncrypted;
    f.row().environment = 'PRODUCTION';
    vi.advanceTimersByTime(61000);
    await f.service().maintenance();
    expect(f.row().codeEncrypted).toBe(encrypted);
  });
  it('expired QR is hidden and its ciphertext is purged without a visitor or remote request', async () => {
    const f = fixture();
    await f.service().prepare(company);
    await f.hook('qrcode.updated', { qrcode: { base64: qr } });
    vi.advanceTimersByTime(61000);
    await f.service().maintenance();
    expect(f.row().codeEncrypted).toBeNull();
    expect(await f.service().get(company)).toMatchObject({
      qrCode: null,
      errorCode: 'CODE_EXPIRED',
    });
    expect(f.client.restartInstance).not.toHaveBeenCalled();
  });
  it('a new QR replaces the expired QR, while repeating that old code cannot make it valid again', async () => {
    const f = fixture();
    await f.service().prepare(company);
    await f.hook('qrcode.updated', { qrcode: { base64: qr } });
    vi.advanceTimersByTime(61000);
    f.client.connectInstance.mockResolvedValue({ base64: qr });
    expect((await f.service().connect(company)).qrCode).toBeNull();
    vi.advanceTimersByTime(1);
    await f.hook('qrcode.updated', { qrcode: { base64: renewed } });
    expect((await f.service().get(company)).qrCode).toBe(renewed);
    expect(f.client.logoutInstance).not.toHaveBeenCalled();
  });
  it('PHONE code and its original digits survive across replicas, without resending phone on GET', async () => {
    const f = fixture();
    await f.service().connect(company, '+55 (12) 99605-5129');
    await f.hook('qrcode.updated', {
      qrcode: { base64: qr, pairingCode: 'ABCD-1234' },
    });
    const dto = await f.service().get(company);
    expect(dto).toMatchObject({
      pairingCode: 'ABCD-1234',
      qrCode: null,
      status: 'CONNECTING',
    });
    expect(
      new SecretVault().decrypt(
        f.row().pairingPhoneEncrypted!,
        `evolution:phone:${f.row().id}`,
      ),
    ).toBe('5512996055129');
    expect(JSON.stringify(dto)).not.toContain('5512996055129');
    f.client.connectInstance.mockClear();
    f.client.connectInstance.mockResolvedValue({ pairingCode: 'NEWW1234' });
    vi.advanceTimersByTime(121000);
    await f.service().reconnect(company);
    expect(f.client.connectInstance).toHaveBeenCalledWith(
      f.row().instanceName,
      '5512996055129',
    );
  });
  it.each([company, GLOBAL_EVOLUTION])(
    'close/401 is terminal, clears both codes and phone, and delayed QR cannot revive %s',
    async (context) => {
      const f = fixture();
      await f.service().connect(context, '5512996055129');
      await f.hook('qrcode.updated', {
        qrcode: { pairingCode: 'ABCD1234', base64: qr },
      });
      vi.advanceTimersByTime(1);
      await f.hook('connection.update', { state: 'close', statusReason: 401 });
      vi.advanceTimersByTime(1);
      await f.hook('qrcode.updated', { qrcode: { base64: renewed } });
      expect(await f.service().get(context)).toMatchObject({
        status: 'DISCONNECTED',
        pairingCode: null,
        qrCode: null,
        disconnectReason: 401,
        errorCode: 'WHATSAPP_LOGGED_OUT',
      });
      expect(f.row().pairingPhoneEncrypted).toBeNull();
      expect(f.row().connectionRequested).toBe(false);
    },
  );
  it('explicit logout removes attempt before remote I/O, and a new connection uses the same instance', async () => {
    const f = fixture();
    await f.service().prepare(company);
    await f.hook('qrcode.updated', { qrcode: { base64: qr } });
    f.client.logoutInstance.mockImplementation(async () => {
      vi.advanceTimersByTime(1);
      await f.hook('qrcode.updated', { qrcode: { base64: renewed } });
      f.state('close');
      return {};
    });
    await f.service().logout(company);
    expect(f.row().codeEncrypted).toBeNull();
    f.client.connectInstance.mockResolvedValue({ base64: renewed });
    expect((await f.service().connect(company)).status).toBe('QR_AVAILABLE');
    expect(f.rows.size).toBe(1);
  });
  it('delete invalidates the old token and explicit recreation never creates a second association', async () => {
    const f = fixture();
    await f.service().prepare(company);
    const token = f.client.setWebhook.mock.calls.at(-1)![2];
    await f.service().remove(company);
    await f.service().prepare(company);
    await expect(
      f.hook(
        'qrcode.updated',
        { qrcode: { base64: qr } },
        new Date(),
        f.row().instanceName,
        token,
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(f.rows.size).toBe(1);
  });
  it('rejects another company name or token and does not return another tenant code', async () => {
    const f = fixture();
    await f.service().prepare(company);
    await f.hook('qrcode.updated', { qrcode: { base64: qr } });
    await f.service().prepare(other);
    await expect(
      f.hook('qrcode.updated', { qrcode: { base64: renewed } }),
    ).rejects.toMatchObject({ status: 401 });
    expect((await f.service().get(company)).qrCode).toBe(qr);
    expect((await f.service().get(other)).qrCode).toBeNull();
  });
  it('no QR within 60 seconds ends waiting; no implicit reconnect/restart occurs', async () => {
    const f = fixture();
    await f.service().prepare(company);
    vi.advanceTimersByTime(61000);
    expect(await f.service().get(company)).toMatchObject({
      status: 'ERROR',
      errorCode: 'CONNECTION_TIMEOUT',
      qrCode: null,
    });
    expect(f.row().pairingPhoneEncrypted).toBeNull();
    expect(f.client.connectInstance).toHaveBeenCalledOnce();
    expect(f.client.restartInstance).not.toHaveBeenCalled();
  });
  it('normalizes separators without inventing, adding or deleting digits', () => {
    for (const text of [
      '+55 (12) 99605-5129',
      '55\t12\u00a099605.5129',
      '5512996055129',
    ])
      expect(evolutionPhone(text)).toBe('5512996055129');
    expect(() => evolutionPhone('000')).toThrow('INVALID_PHONE');
  });
  it('logs context and safe categories only, never codes, phone, keys or tokens', async () => {
    const f = fixture();
    await f.service().connect(company, '5512996055129');
    await f.hook('qrcode.updated', {
      qrcode: { pairingCode: 'ABCD1234', base64: qr },
    });
    const logs = JSON.stringify(logEntries);
    for (const secret of [
      qr,
      'ABCD1234',
      '5512996055129',
      'must-never-escape',
      f.client.setWebhook.mock.calls.at(-1)![2],
    ])
      expect(logs).not.toContain(secret);
    expect(logs).toContain('Webhook processed');
  });
});
