import { randomUUID } from 'node:crypto';
import type { EvolutionConnection } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { SecretVault } from '../billing/secret-vault.js';
import { EvolutionClient, EvolutionFailure } from './evolution-client.js';
import {
  EvolutionService,
  evolutionInstanceName,
  evolutionStatus,
} from './evolution.js';
const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
const qr = 'data:image/png;base64,iVBORw0KGgo=';
function fixture() {
  const rows = new Map<string, EvolutionConnection>();
  const remote = new Set<string>();
  const states = new Map<string, string>();
  const find = (where: { id?: string; companyId?: string }) =>
    [...rows.values()].find((row) =>
      where.id ? row.id === where.id : row.companyId === where.companyId,
    ) ?? null;
  const db = {
    evolutionConnection: {
      upsert: vi.fn(async ({ where, create }) => {
        const found = find(where);
        if (found) return { ...found };
        const row = {
          id: randomUUID(),
          status: 'PENDING',
          prepared: false,
          pairingMethod: 'QR',
          phone: null,
          profileName: null,
          connectedAt: null,
          disconnectedAt: null,
          lastSeenAt: null,
          lastQrAt: null,
          lastError: null,
          webhookSecretEncrypted: null,
          lastWebhookAt: null,
          leaseId: null,
          leaseExpiresAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...create,
        } as EvolutionConnection;
        rows.set(row.id, row);
        return { ...row };
      }),
      findUnique: vi.fn(async ({ where }) => {
        const row = find(where);
        return row ? { ...row } : null;
      }),
      findUniqueOrThrow: vi.fn(async ({ where }) => {
        const row = find(where);
        if (!row) throw new Error();
        return { ...row };
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        const row = find(where);
        if (!row) return { count: 0 };
        if (where.OR && row.leaseId && row.leaseExpiresAt! >= new Date())
          return { count: 0 };
        if (where.leaseId && row.leaseId !== where.leaseId) return { count: 0 };
        if (
          where.leaseExpiresAt?.gt &&
          row.leaseExpiresAt! <= where.leaseExpiresAt.gt
        )
          return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
  };
  const client = {
    fetchInstances: vi.fn(async (name) =>
      remote.has(name)
        ? {
            name,
            integration: 'WHATSAPP-BAILEYS',
            ownerJid: '5511999999999@s.whatsapp.net',
            profileName: 'Ana',
            token: 'private-token',
          }
        : null,
    ),
    createInstance: vi.fn(async (name) => {
      remote.add(name);
      states.set(name, 'close');
      return { hash: 'private-token' };
    }),
    setWebhook: vi.fn(
      async (_name: string, _url: string, _token: string) => ({}),
    ),
    fetchConnectionState: vi.fn(async (name) => ({
      instance: { state: states.get(name) ?? 'close' },
    })),
    connectInstance: vi.fn(async (name, number) => {
      states.set(name, 'connecting');
      return { base64: qr, ...(number ? { pairingCode: 'ABCD1234' } : {}) };
    }),
    restartInstance: vi.fn(async () => ({})),
    logoutInstance: vi.fn(async (name) => {
      states.set(name, 'close');
      return {};
    }),
    deleteInstance: vi.fn(async (name) => {
      remote.delete(name);
      return {};
    }),
    sendTextMessage: vi.fn(async () => ({
      accepted: true,
      messageId: 'message_1',
    })),
  };
  const service = new EvolutionService(
    db as unknown as PrismaService,
    client as unknown as EvolutionClient,
    new SecretVault(),
  );
  return {
    db,
    rows,
    remote,
    states,
    client,
    service,
    row: (companyId = a) => find({ companyId })!,
  };
}
describe('tenant Evolution lifecycle', () => {
  beforeEach(() => {
    vi.stubEnv('GATEWAY_ENCRYPTION_KEY', 'a'.repeat(64));
    vi.stubEnv('EVOLUTION_WEBHOOK_BASE_URL', 'https://api.kalend.tech');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });
  it('uses deterministic safe names and unique company upsert', async () => {
    const f = fixture();
    await f.service.prepare(a);
    expect(evolutionInstanceName(a)).toBe(
      'kalend_11111111111141118111111111111111',
    );
    expect(f.db.evolutionConnection.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { companyId: a } }),
    );
    expect(f.row().prepared).toBe(true);
    expect(f.client.createInstance).toHaveBeenCalledOnce();
  });
  it('provisions only once on retries, and uses existing remote instances', async () => {
    const f = fixture();
    f.remote.add(evolutionInstanceName(a));
    await f.service.prepare(a);
    await f.service.prepare(a);
    expect(f.client.createInstance).not.toHaveBeenCalled();
    expect(f.client.setWebhook).toHaveBeenCalledOnce();
    const g = fixture();
    await g.service.prepare(a);
    await g.service.prepare(a);
    expect(g.client.createInstance).toHaveBeenCalledOnce();
  });
  it('recovers ambiguous create outcomes without a second instance', async () => {
    const f = fixture();
    f.client.createInstance.mockImplementationOnce(async (name) => {
      f.remote.add(name);
      throw new EvolutionFailure('EVOLUTION_UNAVAILABLE');
    });
    await f.service.prepare(a);
    await f.service.prepare(a);
    expect(f.client.createInstance).toHaveBeenCalledOnce();
    expect(f.row().prepared).toBe(true);
  });
  it('returns a safe QR DTO without identifiers, credentials or remote payloads', async () => {
    const f = fixture();
    const result = await f.service.prepare(a);
    expect(result.status).toBe('QR_AVAILABLE');
    expect(result.qrCode).toBe(qr);
    expect(JSON.stringify(result)).not.toMatch(
      /instanceName|companyId|webhookSecret|private-token|hash|leaseId/,
    );
    expect(f.row()).not.toHaveProperty('qrCode');
  });
  it('does not extend QR expiry when polling the same code', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const first = await f.service.prepare(a);
    vi.advanceTimersByTime(10000);
    const second = await f.service.get(a);
    expect(second.qrExpiresAt).toBe(first.qrExpiresAt);
    vi.advanceTimersByTime(40000);
    expect((await f.service.get(a)).qrCode).toBeNull();
  });
  it('maps connected/disconnected and captures phone/profile', async () => {
    const f = fixture();
    await f.service.prepare(a);
    f.states.set(f.row().instanceName, 'open');
    const connected = await f.service.get(a);
    expect(connected).toMatchObject({
      status: 'CONNECTED',
      phone: '+5511999999999',
      profileName: 'Ana',
      qrCode: null,
    });
    f.states.set(f.row().instanceName, 'close');
    expect((await f.service.get(a)).status).toBe('DISCONNECTED');
    expect(f.row().disconnectedAt).not.toBeNull();
    expect(evolutionStatus('refused')).toBe('ERROR');
  });
  it('logs out but preserves association and reconnects the same instance', async () => {
    const f = fixture();
    await f.service.prepare(a);
    f.states.set(f.row().instanceName, 'open');
    expect((await f.service.logout(a)).status).toBe('DISCONNECTED');
    const calls = f.client.connectInstance.mock.calls.length;
    await f.service.get(a);
    expect(f.client.connectInstance.mock.calls.length).toBe(calls);
    await f.service.connect(a);
    expect(f.client.createInstance).toHaveBeenCalledOnce();
  });
  it('deletes remote instance and resets connection without deleting company', async () => {
    const f = fixture();
    await f.service.prepare(a);
    expect(await f.service.remove(a)).toMatchObject({
      status: 'PENDING',
      qrCode: null,
    });
    expect(f.row().prepared).toBe(false);
    expect(f.row().webhookSecretEncrypted).toBeNull();
    expect(f.client.deleteInstance).toHaveBeenCalledWith(
      evolutionInstanceName(a),
    );
    await f.service.prepare(a);
    expect(f.remote.size).toBe(1);
  });
  it('keeps failures recoverable and sanitizes error detail', async () => {
    const f = fixture();
    f.client.fetchInstances.mockRejectedValueOnce(
      new Error('API-key private stack'),
    );
    const result = await f.service.prepare(a);
    expect(result).toMatchObject({
      status: 'ERROR',
      errorCode: 'EVOLUTION_UNAVAILABLE',
    });
    expect(JSON.stringify(result)).not.toMatch(/API-key|stack/);
    await f.service.prepare(a);
    expect(f.client.createInstance).toHaveBeenCalledOnce();
    f.client.fetchInstances.mockRejectedValueOnce(new Error());
    await expect(
      f.service.prepareAfterCompanyCreated(b),
    ).resolves.toBeUndefined();
  });
  it('blocks simultaneous management with a shared database lease', async () => {
    const f = fixture();
    await f.service.get(a);
    let resume!: () => void;
    f.client.fetchInstances.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        resume = resolve;
      });
      return null;
    });
    const pending = f.service.prepare(a);
    await vi.waitFor(() => expect(resume).toBeTypeOf('function'));
    await expect(f.service.prepare(a)).rejects.toThrow('andamento');
    resume();
    await pending;
    expect(f.client.createInstance).toHaveBeenCalledOnce();
  });
  it('isolates tenants throughout management and QR fetching', async () => {
    const f = fixture();
    await f.service.prepare(a);
    await f.service.prepare(b);
    f.states.set(evolutionInstanceName(a), 'open');
    expect((await f.service.get(a)).status).toBe('CONNECTED');
    expect((await f.service.get(b)).status).toBe('QR_AVAILABLE');
    await f.service.logout(a);
    expect(f.states.get(evolutionInstanceName(b))).toBe('connecting');
    expect(f.rows.size).toBe(2);
  });
  it('switches pending QR to officially supported pairing with international number', async () => {
    const f = fixture();
    await f.service.prepare(a);
    const result = await f.service.connect(a, '+5511888888888');
    expect(f.client.logoutInstance).toHaveBeenCalledWith(
      evolutionInstanceName(a),
    );
    expect(f.client.connectInstance).toHaveBeenLastCalledWith(
      evolutionInstanceName(a),
      '5511888888888',
    );
    expect(result).toMatchObject({
      status: 'CONNECTING',
      pairingCode: 'ABCD1234',
      qrCode: null,
    });
    f.client.connectInstance.mockResolvedValueOnce({
      base64: qr,
      pairingCode: 'ABCD1234',
    });
    expect((await f.service.get(a)).qrCode).toBeNull();
    await expect(f.service.connect(a, 'invalid')).rejects.toThrow('DDI');
  });
  it('does not trust an open connect payload while connectionState remains connecting', async () => {
    const f = fixture();
    f.client.connectInstance.mockImplementationOnce(async (name) => {
      f.states.set(name, 'connecting');
      return {
        instance: { state: 'open' },
        pairingCode: 'ABCD1234',
        base64: qr,
      };
    });
    const result = await f.service.connect(a, '+55 (12) 99605-5129');
    expect(result.status).toBe('CONNECTING');
    expect(result.pairingCode).toBe('ABCD1234');
    f.states.set(evolutionInstanceName(a), 'open');
    expect((await f.service.get(a)).status).toBe('CONNECTED');
  });
  it('preserves phone pairing method across API processes and recovers expired leases', async () => {
    const f = fixture();
    await f.service.prepare(a);
    await f.service.connect(a, '+5511999999999');
    expect(f.row().pairingMethod).toBe('PHONE');
    const otherProcess = new EvolutionService(
      f.db as unknown as PrismaService,
      f.client as unknown as EvolutionClient,
      new SecretVault(),
    );
    f.client.connectInstance.mockResolvedValueOnce({
      base64: qr,
      pairingCode: 'ABCD1234',
    });
    const result = await otherProcess.get(a);
    expect(result).toMatchObject({
      status: 'CONNECTING',
      pairingCode: 'ABCD1234',
      qrCode: null,
    });
    const row = f.rows.get(f.row().id)!;
    row.leaseId = randomUUID();
    row.leaseExpiresAt = new Date(Date.now() - 1);
    await expect(otherProcess.get(a)).resolves.toBeDefined();
  });
  it('returns sanitized waiting codes when QR/pairing are not supplied yet', async () => {
    const f = fixture();
    f.client.connectInstance.mockResolvedValueOnce({} as never);
    expect(await f.service.prepare(a)).toMatchObject({
      status: 'CONNECTING',
      errorCode: 'QR_UNAVAILABLE',
      qrCode: null,
    });
    f.client.connectInstance.mockResolvedValueOnce({} as never);
    expect(await f.service.connect(a, '+5511999999999')).toMatchObject({
      status: 'CONNECTING',
      errorCode: 'PAIRING_CODE_UNAVAILABLE',
    });
  });
  it('sends messages through resolved tenant connection only', async () => {
    const f = fixture();
    await f.service.prepare(a);
    f.states.set(evolutionInstanceName(a), 'open');
    expect(await f.service.sendTextMessage(a, '+5511999999999', 'Olá')).toEqual(
      { accepted: true, messageId: 'message_1' },
    );
    expect(f.client.sendTextMessage).toHaveBeenCalledWith(
      evolutionInstanceName(a),
      '+5511999999999',
      'Olá',
    );
  });
  it('authenticates webhooks, verifies instance and ignores stale events', async () => {
    const f = fixture();
    await f.service.prepare(a);
    const row = f.row();
    const token = f.client.setWebhook.mock.calls[0][2];
    const body = {
      instance: row.instanceName,
      event: 'connection.update',
      data: { state: 'open' },
      date_time: new Date().toISOString(),
      apikey: 'private',
    };
    await expect(f.service.webhook(row.id, undefined, body)).rejects.toThrow(
      'inválido',
    );
    await expect(
      f.service.webhook(row.id, 'ç'.repeat(64), body),
    ).rejects.toThrow('inválido');
    await expect(
      f.service.webhook(row.id, token, {
        ...body,
        instance: evolutionInstanceName(b),
      }),
    ).rejects.toThrow('inválido');
    f.states.set(row.instanceName, 'open');
    await f.service.webhook(row.id, token, body);
    expect(f.row().status).toBe('CONNECTED');
    const calls = f.client.fetchConnectionState.mock.calls.length;
    await f.service.webhook(row.id, token, body);
    expect(f.client.fetchConnectionState.mock.calls.length).toBe(calls);
    expect(JSON.stringify(await f.service.get(a))).not.toContain('private');
  });
  it('authenticates QR webhook and never resurrects a logged-out session', async () => {
    const f = fixture();
    await f.service.prepare(a);
    const row = f.row();
    const token = f.client.setWebhook.mock.calls[0][2];
    const body = {
      instance: row.instanceName,
      event: 'qrcode.updated',
      data: { qrcode: { base64: qr } },
      date_time: new Date().toISOString(),
    };
    await f.service.webhook(row.id, token, body);
    expect(f.row().status).toBe('QR_AVAILABLE');
    await f.service.logout(a);
    await f.service.webhook(row.id, token, {
      ...body,
      date_time: new Date(Date.now() + 1).toISOString(),
    });
    expect(f.row().status).toBe('DISCONNECTED');
    expect((await f.service.get(a)).qrCode).toBeNull();
  });
});
