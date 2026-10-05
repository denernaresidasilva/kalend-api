import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import {
  ForbiddenException,
  UnauthorizedException,
  type INestApplication,
} from '@nestjs/common';
import { createServer, type RequestOptions } from 'node:https';
import type { Server } from 'node:https';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import request from 'supertest';
import {
  CompanyEvolutionController,
  GlobalEvolutionController,
  EvolutionWebhookController,
} from './evolution.controller.js';
import {
  EvolutionService,
  GLOBAL_EVOLUTION,
  evolutionInstanceName,
} from './evolution.js';
import { EvolutionClient } from './evolution-client.js';
import { SecretVault } from '../billing/secret-vault.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TenantGuard } from '../auth/tenant.guard.js';
import { AdminGuard } from '../common/admin.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { AuthConfig } from '../auth/auth.config.js';
import { AuthRateLimit } from '../auth/auth-rate-limit.service.js';
import { evolutionDatabase } from '../../test/support/evolution-database.js';
const bridge = vi.hoisted(() => ({ port: 0, ca: '' }));
vi.mock('node:https', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:https')>();
  return {
    ...real,
    request: (url: URL, options: RequestOptions, cb: any) => {
      if (url.hostname !== 'evolution-api.kalend.tech')
        throw new Error('Unexpected remote host');
      return real.request(
        {
          ...options,
          hostname: '127.0.0.1',
          port: bridge.port,
          path: url.pathname + url.search,
          lookup: undefined,
          ca: bridge.ca,
          servername: 'evolution-api.kalend.tech',
        },
        cb,
      );
    },
  };
});
vi.mock('./network.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./network.js')>()),
  resolvePublic: async () => '8.8.8.8',
}));
const companyA = '11111111-1111-4111-8111-111111111111';
const companyB = '22222222-2222-4222-8222-222222222222';
const png = 'data:image/png;base64,iVBORw0KGgo=';
const webRoot = resolve('../kalend-web');
const availableWeb =
  existsSync(join(webRoot, 'node_modules/react')) &&
  existsSync(join(webRoot, 'node_modules/jsdom'));
const webRequire = createRequire(join(webRoot, 'package.json'));

const React = availableWeb ? webRequire('react') : null;
const { JSDOM } = availableWeb ? webRequire('jsdom') : { JSDOM: null };
const { createRoot } = availableWeb
  ? webRequire('react-dom/client')
  : { createRoot: null };

describe('Evolution full HTTP contract: React → Kalend → TLS Evolution simulator', () => {
  let app: INestApplication;
  let server: Server;
  let base: string;
  const f = evolutionDatabase();
  const remote = new Map<
    string,
    { state: string; pairingCode?: string; qrCode?: string; webhook?: any }
  >();
  const calls: Array<{ method: string; path: string; body: any }> = [];
  let failStatus = 0;
  let errorBody = false;
  let delayedCreate = false;
  let delayResponse = false;
  let browserUser = 'admin';
  beforeAll(async () => {
    vi.stubEnv('EVOLUTION_WEBHOOK_BASE_URL', 'https://api.kalend.tech');
    vi.stubEnv('EVOLUTION_API_KEY', 'integration-test-only-key');
    vi.stubEnv('GATEWAY_ENCRYPTION_KEY', 'a'.repeat(64));
    vi.stubEnv('AUTH_ALLOWED_ORIGINS', 'https://web.example.test');
    const dir = mkdtempSync(join(tmpdir(), 'kalend-evolution-tls-'));
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
        '-subj',
        '/CN=evolution-api.kalend.tech',
        '-addext',
        'subjectAltName=DNS:evolution-api.kalend.tech',
        '-days',
        '1',
      ],
      { stdio: 'ignore' },
    );
    bridge.ca = readFileSync(join(dir, 'cert.pem'), 'utf8');
    server = createServer(
      { key: readFileSync(join(dir, 'key.pem')), cert: bridge.ca },
      async (req, res) => {
        const url = new URL(req.url!, 'https://evolution-api.kalend.tech');
        const parts = url.pathname.split('/');
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const body = raw ? JSON.parse(raw) : {};
        calls.push({
          method: req.method!,
          path: url.pathname + url.search,
          body,
        });
        const send = (status: number, data: any) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(data));
        };
        if (req.headers.apikey !== 'integration-test-only-key')
          return send(401, { message: 'private key' });
        if (failStatus)
          return send(failStatus, {
            message: 'integration-test-only-key private stack',
          });
        if (delayResponse) await new Promise((r) => setTimeout(r, 80));
        if (url.pathname === '/instance/create') {
          if (delayedCreate) await new Promise((r) => setTimeout(r, 80));
          if (remote.has(body.instanceName))
            return send(400, { message: 'Already exists' });
          remote.set(body.instanceName, { state: 'close' });
          return send(201, {
            instance: { instanceName: body.instanceName },
            hash: 'private-instance-token',
          });
        }
        if (url.pathname === '/instance/fetchInstances') {
          const name = url.searchParams.get('instanceName')!;
          return remote.has(name)
            ? send(200, [
                {
                  name,
                  integration: 'WHATSAPP-BAILEYS',
                  ownerJid: '5511999999999@s.whatsapp.net',
                  profileName: 'Kalend',
                  token: 'private-instance-token',
                },
              ])
            : send(404, { message: 'Not found' });
        }
        const name = decodeURIComponent(parts[3] ?? '');
        const instance = remote.get(name);
        if (!instance) return send(404, {});
        if (parts[1] === 'webhook') {
          instance.webhook = body.webhook;
          return send(201, {});
        }
        if (parts[2] === 'connectionState')
          return send(200, { instance: { state: instance.state } });
        if (parts[2] === 'restart') {
          if (instance.state === 'close') return send(400, { error: true });
          instance.qrCode = 'data:image/png;base64,iVBORw0KGgoDAw==';
          return send(200, { instance: { state: instance.state } });
        }
        if (parts[2] === 'connect') {
          if (errorBody)
            return send(200, {
              error: true,
              message: 'integration-test-only-key private',
            });
          if (instance.state === 'open')
            return send(200, { instance: { state: 'open' } });
          instance.state = 'connecting';
          if (url.searchParams.has('number'))
            instance.pairingCode = 'ABCD-1234';
          return send(200, {
            base64:
              instance.qrCode ??
              (name === evolutionInstanceName(companyB)
                ? 'data:image/png;base64,iVBORw0KGgoCAg=='
                : png),
            pairingCode: instance.pairingCode ?? null,
            apikey: 'private',
          });
        }
        if (parts[2] === 'logout') {
          instance.state = 'close';
          instance.pairingCode = undefined;
          return send(200, { status: 'SUCCESS' });
        }
        if (parts[2] === 'delete') {
          remote.delete(name);
          return send(200, {});
        }
        if (parts[2] === 'sendText')
          return send(201, { key: { id: 'message_1' } });
        return send(404, {});
      },
    );
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    bridge.port = (server.address() as any).port;
    const module = await Test.createTestingModule({
      controllers: [
        GlobalEvolutionController,
        CompanyEvolutionController,
        EvolutionWebhookController,
      ],
      providers: [
        EvolutionClient,
        EvolutionService,
        SecretVault,
        AdminGuard,
        TenantGuard,
        AuthConfig,
        { provide: PrismaService, useValue: f.db },
        { provide: AuthRateLimit, useValue: { consume: async () => {} } },
        {
          provide: AuthService,
          useValue: {
            authenticate: async (token: string) => {
              if (
                ![
                  'admin',
                  'owner-a',
                  'owner-b',
                  'client',
                  'professional',
                  'receptionist',
                ].includes(token)
              )
                throw new UnauthorizedException();
              return {
                user: { id: token, isSuperAdmin: token === 'admin' },
                session: {
                  selectedCompanyId: token === 'owner-b' ? companyB : companyA,
                },
              };
            },
            membership: async (user: string, companyId: string) => {
              if (companyId !== (user === 'owner-b' ? companyB : companyA))
                throw new ForbiddenException();
              return {
                id: 'membership',
                role:
                  user === 'professional'
                    ? 'PROFESSIONAL'
                    : user === 'receptionist'
                      ? 'RECEPTIONIST'
                      : user === 'client'
                        ? 'CLIENT'
                        : 'OWNER',
              };
            },
          },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    // Auth probe for the real web API client; guard authentication is still exercised by all integration routes.
    app.use('/auth/me', (req: any, res: any) => {
      const user = /__Host-kalend_access=([^;]+)/.exec(
        req.headers.cookie ?? '',
      )?.[1];
      res.json({
        user: { id: user },
        systemRole: user === 'admin' ? 'SUPER_ADMIN' : 'USER',
        selectedCompanyId: user === 'owner-b' ? companyB : companyA,
      });
    });
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });
  afterAll(async () => {
    await app?.close();
    await new Promise<void>((r) => server?.close(() => r()));
    vi.unstubAllEnvs();
  });
  beforeEach(() => {
    vi.stubEnv('EVOLUTION_WEBHOOK_BASE_URL', 'https://api.kalend.tech');
    f.reset();
    remote.clear();
    calls.length = 0;
    failStatus = 0;
    errorBody = false;
    delayedCreate = false;
    delayResponse = false;
    browserUser = 'admin';
  });
  const post = (path: string, body: any = {}, user = 'admin') =>
    request(app.getHttpServer())
      .post(path)
      .set('Cookie', `__Host-kalend_access=${user}`)
      .set('Origin', 'https://web.example.test')
      .send(body);
  const get = (path: string, user = 'admin') =>
    request(app.getHttpServer())
      .get(path)
      .set('Cookie', `__Host-kalend_access=${user}`);
  const globalPath = '/communication/evolution';
  it('automatically creates GLOBAL, returns QR, and never leaks instance or credentials', async () => {
    const result = await post(globalPath + '/prepare');
    expect(result.status).toBe(201);
    expect(result.body.status).toBe('QR_AVAILABLE');
    expect(result.body.qrCode).toBe(png);
    expect(JSON.stringify(result.body)).not.toMatch(
      /kalend_global|integration-test-only-key|private-instance-token|webhookSecret|globalKey/,
    );
    expect(calls.map((c) => c.method + ' ' + c.path)).toContain(
      'POST /instance/create',
    );
    expect(remote.get('kalend_global')!.webhook.url).toContain(
      '/evolution/global/',
    );
    await post(globalPath + '/prepare');
    expect(calls.filter((c) => c.path === '/instance/create')).toHaveLength(1);
  });
  it('keeps one GLOBAL across competing requests and service replicas', async () => {
    delayedCreate = true;
    const results = await Promise.all([
      post(globalPath + '/prepare'),
      post(globalPath + '/prepare'),
    ]);
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      201, 409,
    ]);
    expect(remote.size).toBe(1);
    const replica = new EvolutionService(
      f.db as unknown as PrismaService,
      new EvolutionClient(),
      new SecretVault(),
    );
    await replica.prepare(GLOBAL_EVOLUTION);
    expect(calls.filter((c) => c.path === '/instance/create')).toHaveLength(1);
  });
  it('adopts a backend legacy GLOBAL without creating a second instance', async () => {
    f.setLegacy('kalend_existing_global');
    remote.set('kalend_existing_global', { state: 'close' });
    await post(globalPath + '/prepare');
    expect(calls.filter((c) => c.path === '/instance/create')).toHaveLength(0);
    expect([...f.rows.values()][0].instanceName).toBe('kalend_existing_global');
  });
  it.each(['owner-a', 'owner-b', 'client', 'professional', 'receptionist'])(
    'rejects %s from all GLOBAL management operations',
    async (user) => {
      expect((await get(globalPath, user)).status).toBe(403);
      for (const route of [
        'prepare',
        'connect',
        'pairing-code',
        'reconnect',
        'logout',
      ])
        expect(
          (
            await post(
              globalPath + '/' + route,
              { phone: '+5511999999999' },
              user,
            )
          ).status,
        ).toBe(403);
      expect(
        (
          await request(app.getHttpServer())
            .delete(globalPath)
            .set('Cookie', `__Host-kalend_access=${user}`)
            .set('Origin', 'https://web.example.test')
            .send({})
        ).status,
      ).toBe(403);
      expect(remote.size).toBe(0);
    },
  );
  it('keeps companies independent from GLOBAL and each other, including webhook boundaries', async () => {
    await post(globalPath + '/prepare');
    await post('/company/communication/evolution/prepare', {}, 'owner-a');
    await post('/company/communication/evolution/prepare', {}, 'owner-b');
    expect(remote.size).toBe(3);
    expect([...f.rows.values()].map((r) => r.instanceName)).toEqual(
      expect.arrayContaining([
        'kalend_global',
        evolutionInstanceName(companyA),
        evolutionInstanceName(companyB),
      ]),
    );
    const company = [...f.rows.values()].find((r) => r.companyId === companyA)!;
    const hook = remote.get(company.instanceName)!.webhook;
    expect(
      (
        await request(app.getHttpServer())
          .post(`/webhooks/communication/evolution/global/${company.id}`)
          .set(
            'x-kalend-evolution-token',
            hook.headers['x-kalend-evolution-token'],
          )
          .send({ instance: company.instanceName })
      ).status,
    ).toBe(401);
    const global = [...f.rows.values()].find((r) => r.globalKey === 'GLOBAL')!;
    expect(
      (
        await request(app.getHttpServer())
          .post(`/webhooks/communication/evolution/${global.id}`)
          .set(
            'x-kalend-evolution-token',
            remote.get('kalend_global')!.webhook.headers[
              'x-kalend-evolution-token'
            ],
          )
          .send({ instance: 'kalend_global' })
      ).status,
    ).toBe(401);
    remote.get(company.instanceName)!.state = 'open';
    expect(
      (
        await get(
          '/company/communication/evolution?companyId=' + companyB,
          'owner-a',
        )
      ).body.status,
    ).toBe('CONNECTED');
    expect(
      (await get('/company/communication/evolution', 'owner-b')).body.status,
    ).toBe('QR_AVAILABLE');
    expect((await get(globalPath)).body.status).toBe('QR_AVAILABLE');
  });
  it('handles pairing, connected, logout, reconnect and explicit deletion over the official HTTP methods', async () => {
    await post(globalPath + '/prepare');
    expect(
      (await post(globalPath + '/pairing-code', { phone: 'invalid' })).status,
    ).toBe(400);
    const pairing = await post(globalPath + '/pairing-code', {
      phone: '+5511999999999',
    });
    expect(pairing.body.pairingCode).toBe('ABCD-1234');
    expect(pairing.body.qrCode).toBeNull();
    expect(
      calls.some(
        (c) =>
          c.method === 'GET' &&
          c.path === '/instance/connect/kalend_global?number=5511999999999',
      ),
    ).toBe(true);
    remote.get('kalend_global')!.state = 'open';
    expect((await get(globalPath)).body).toMatchObject({
      status: 'CONNECTED',
      qrCode: null,
      phone: '+5511999999999',
    });
    expect((await post(globalPath + '/logout')).body.status).toBe(
      'DISCONNECTED',
    );
    await get(globalPath);
    expect(remote.get('kalend_global')!.state).toBe('close');
    expect((await post(globalPath + '/reconnect')).body.status).toBe(
      'QR_AVAILABLE',
    );
    const deleted = await request(app.getHttpServer())
      .delete(globalPath)
      .set('Cookie', '__Host-kalend_access=admin')
      .set('Origin', 'https://web.example.test')
      .send({});
    expect(deleted.body.status).toBe('PENDING');
    expect(remote.size).toBe(0);
    await get(globalPath);
    expect(remote.size).toBe(0);
    await post(globalPath + '/prepare');
    expect(remote.size).toBe(1);
    expect(calls.map((c) => c.method + ' ' + c.path)).toEqual(
      expect.arrayContaining([
        'DELETE /instance/logout/kalend_global',
        'DELETE /instance/delete/kalend_global',
      ]),
    );
  });
  it('sanitizes HTTP errors and 200 error envelopes without losing recovery', async () => {
    failStatus = 503;
    expect((await post(globalPath + '/prepare')).body.errorCode).toBe(
      'EVOLUTION_UNAVAILABLE',
    );
    failStatus = 0;
    errorBody = true;
    const result = await post(globalPath + '/prepare');
    expect(result.body.status).toBe('ERROR');
    expect(JSON.stringify(result.body)).not.toMatch(
      /integration-test-only-key|private stack/,
    );
    errorBody = false;
    expect((await post(globalPath + '/prepare')).body.status).toBe(
      'QR_AVAILABLE',
    );
    expect(calls.filter((c) => c.path === '/instance/create')).toHaveLength(1);
  });
  it('updates GLOBAL through its authenticated webhook and rejects another instance', async () => {
    await post(globalPath + '/prepare');
    const row = [...f.rows.values()][0];
    const hook = remote.get('kalend_global')!.webhook;
    const url = `/webhooks/communication/evolution/global/${row.id}`;
    const token = hook.headers['x-kalend-evolution-token'];
    const payload = {
      instance: 'kalend_global',
      event: 'connection.update',
      date_time: new Date().toISOString(),
      data: { state: 'open' },
      apikey: 'private',
    };
    expect(
      (await request(app.getHttpServer()).post(url).send(payload)).status,
    ).toBe(401);
    remote.get('kalend_global')!.state = 'open';
    expect(
      (
        await request(app.getHttpServer())
          .post(url)
          .set('x-kalend-evolution-token', token)
          .send(payload)
      ).status,
    ).toBe(201);
    expect((await get(globalPath)).body.status).toBe('CONNECTED');
    expect(
      (
        await request(app.getHttpServer())
          .post(url)
          .set('x-kalend-evolution-token', token)
          .send({ ...payload, instance: evolutionInstanceName(companyA) })
      ).status,
    ).toBe(401);
  });

  it('never sends GLOBAL text to a tenant client and resolves authorized recipient inside the backend', async () => {
    await post(globalPath + '/prepare');
    remote.get('kalend_global')!.state = 'open';
    const service = app.get(EvolutionService);
    await expect(service.sendGlobalTextMessage('client', 'No')).rejects.toThrow(
      'Destinatário',
    );
    await expect(
      service.sendGlobalTextMessage('professional', 'No'),
    ).rejects.toThrow('Destinatário');
    expect(calls.some((call) => call.path.startsWith('/message'))).toBe(false);
    await service.sendGlobalTextMessage('owner-a', 'Aviso do Kalend');
    expect(
      calls.find((call) => call.path === '/message/sendText/kalend_global')!
        .body.number,
    ).toBe('5511999999999');
  });
  it('retains isolated tenant instances across two tabs and refuses direct company identifiers', async () => {
    delayedCreate = true;
    const results = await Promise.all([
      post('/company/communication/evolution/prepare', {}, 'owner-a'),
      post('/company/communication/evolution/prepare', {}, 'owner-a'),
    ]);
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      201, 409,
    ]);
    await post('/company/communication/evolution/prepare', {}, 'owner-b');
    expect(
      calls.filter((call) => call.path === '/instance/create'),
    ).toHaveLength(2);
    expect(
      (
        await post(
          '/company/communication/evolution/connect',
          { companyId: companyB },
          'owner-a',
        )
      ).status,
    ).toBe(400);
    expect(
      (await get('/company/communication/evolution/' + companyB, 'owner-a'))
        .status,
    ).toBe(404);
    expect(
      (await get('/company/communication/evolution/' + companyA, 'owner-b'))
        .status,
    ).toBe(404);
  });
  it('invalidates old GLOBAL webhook credentials after deletion and retry', async () => {
    await post(globalPath + '/prepare');
    const row = [...f.rows.values()][0];
    const token =
      remote.get('kalend_global')!.webhook.headers['x-kalend-evolution-token'];
    await request(app.getHttpServer())
      .delete(globalPath)
      .set('Cookie', '__Host-kalend_access=admin')
      .set('Origin', 'https://web.example.test')
      .send({});
    await post(globalPath + '/prepare');
    const res = await request(app.getHttpServer())
      .post('/webhooks/communication/evolution/global/' + row.id)
      .set('x-kalend-evolution-token', token)
      .send({
        instance: 'kalend_global',
        event: 'connection.update',
        date_time: new Date().toISOString(),
      });
    expect(res.status).toBe(401);
  });
  it('uses DEV webhook and disjoint names through the actual HTTP client, never the production instance', async () => {
    vi.stubEnv('EVOLUTION_WEBHOOK_BASE_URL', 'https://api-dev.kalend.tech');
    remote.set('kalend_global', { state: 'open' });
    remote.set(evolutionInstanceName(companyA), { state: 'open' });
    await post(globalPath + '/prepare');
    await post('/company/communication/evolution/prepare', {}, 'owner-a');
    expect(remote.get('kalend_global')!.state).toBe('open');
    expect(remote.get(evolutionInstanceName(companyA))!.state).toBe('open');
    expect(remote.get('kalend_dev_global')!.webhook.url).toMatch(
      /^https:\/\/api-dev\.kalend\.tech\//,
    );
    expect(remote.has(evolutionInstanceName(companyA, 'DEV'))).toBe(true);
    expect(
      calls.some(
        (c) =>
          c.path.includes('/kalend_global') ||
          c.path.includes('/' + evolutionInstanceName(companyA) + '?'),
      ),
    ).toBe(false);
    const row = [...f.rows.values()].find((r) => r.globalKey === 'GLOBAL')!;
    const token =
      remote.get('kalend_dev_global')!.webhook.headers[
        'x-kalend-evolution-token'
      ];
    expect(
      (
        await request(app.getHttpServer())
          .post('/webhooks/communication/evolution/global/' + row.id)
          .set('x-kalend-evolution-token', token)
          .send({
            instance: 'kalend_global',
            event: 'connection.update',
            date_time: new Date().toISOString(),
          })
      ).status,
    ).toBe(401);
  });
  it('fails missing DEV callback explicitly and makes no remote HTTP request', async () => {
    vi.stubEnv('EVOLUTION_WEBHOOK_BASE_URL', '');
    const result = await post(globalPath + '/prepare');
    expect(result.status).toBe(503);
    expect(result.body.errorCode).toBe('EVOLUTION_WEBHOOK_BASE_URL_REQUIRED');
    expect(calls).toHaveLength(0);
  });
  it('renews an expired QR over POST restart on the same instance and shares its new expiry between replicas', async () => {
    await post(globalPath + '/prepare');
    const row = [...f.rows.values()][0];
    row.codeExpiresAt = new Date(Date.now() - 1);
    const result = await get(globalPath);
    expect(result.body.qrCode).toBe('data:image/png;base64,iVBORw0KGgoDAw==');
    const replica = new EvolutionService(
      f.db as unknown as PrismaService,
      new EvolutionClient(),
      new SecretVault(),
    );
    const second = await replica.get(GLOBAL_EVOLUTION);
    expect(second.qrExpiresAt).toBe(result.body.qrExpiresAt);
    expect(calls.filter((c) => c.path === '/instance/create')).toHaveLength(1);
    expect(
      calls.filter(
        (c) =>
          c.path === '/instance/restart/kalend_global' && c.method === 'POST',
      ),
    ).toHaveLength(1);
    expect(calls.some((c) => c.path.startsWith('/instance/delete'))).toBe(
      false,
    );
    expect(remote.size).toBe(1);
  });
  function loadWeb(file: string, dom: any): any {
    const full = join(webRoot, file);
    const mod = { exports: {} };
    const compiled = ts.transpileModule(readFileSync(full, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
    }).outputText;
    runInNewContext(
      compiled,
      {
        module: mod,
        exports: mod.exports,
        require: (id: string) => {
          if (id === './auth-provider')
            return { useAuth: () => ({ profile: null, loading: false }) };
          if (id.startsWith('@/') || id.startsWith('.')) {
            const path = id.startsWith('@/')
              ? id.slice(2)
              : join(dirname(file), id);
            const candidate = ['.ts', '.tsx'].find((ext) => {
              try {
                readFileSync(join(webRoot, path + ext));
                return true;
              } catch {
                return false;
              }
            });
            return loadWeb(path + candidate, dom);
          }
          return webRequire(id);
        },
        process: { env: { NEXT_PUBLIC_API_URL: base } },
        window: dom.window,
        document: dom.window.document,
        navigator: {
          locks: { request: async (_name: string, work: any) => work() },
        },
        fetch: (url: string, init: any) =>
          fetch(url, {
            ...init,
            headers: {
              ...init?.headers,
              Cookie: `__Host-kalend_access=${browserUser}`,
              Origin: 'https://web.example.test',
            },
          }),
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        URL,
        AbortController,
        Date,
        Error,
      },
      { filename: full },
    );
    return mod.exports;
  }
  it.skipIf(!availableWeb)(
    'renders automatic GLOBAL QR through real web client, API, Evolution TLS response and React',
    async () => {
      const dom = new JSDOM('<div id="root"></div>', {
        url: 'https://web.example.test',
      });
      (globalThis as any).window = dom.window;
      (globalThis as any).document = dom.window.document;
      (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
      const component = loadWeb(
        'components/evolution-settings.tsx',
        dom,
      ).EvolutionPanel;
      const root = createRoot(dom.window.document.getElementById('root'));
      try {
        await React.act(async () => {
          root.render(
            React.createElement(component, {
              context: { scope: 'GLOBAL', userId: 'admin' },
              initiallyOpen: true,
            }),
          );
          await new Promise((r) => setTimeout(r, 100));
        });
        await React.act(async () => {
          await new Promise((r) => setTimeout(r, 150));
        });
        expect(dom.window.document.querySelector('img')?.src).toBe(png);
        expect(dom.window.document.body.textContent).toContain(
          'Aguardando conexão',
        );
        expect(remote.size).toBe(1);
        expect(dom.window.document.body.textContent).not.toMatch(
          /Sandbox|Gerar novo QR|integration-test-only-key|kalend_global/,
        );
        remote.get('kalend_global')!.state = 'open';
        await React.act(async () => {
          [...dom.window.document.querySelectorAll('button')]
            .find((b: any) => b.textContent === 'Atualizar estado')
            .click();
          await new Promise((r) => setTimeout(r, 100));
        });
        expect(dom.window.document.body.textContent).toContain(
          'WhatsApp conectado',
        );
        expect(dom.window.document.querySelector('img')).toBeNull();
      } finally {
        await React.act(async () => root.unmount());
        dom.window.close();
        delete (globalThis as any).window;
        delete (globalThis as any).document;
        delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
      }
    },
  );
  it.skipIf(!availableWeb)(
    'renders GLOBAL phone code and performs logout/delete through the real frontend HTTP client',
    async () => {
      const dom = new JSDOM('<div id="root"></div>', {
        url: 'https://web.example.test',
      });
      Object.assign(globalThis, {
        window: dom.window,
        document: dom.window.document,
        IS_REACT_ACT_ENVIRONMENT: true,
      });
      dom.window.confirm = () => true;
      const component = loadWeb(
        'components/evolution-settings.tsx',
        dom,
      ).EvolutionPanel;
      const root = createRoot(dom.window.document.getElementById('root'));
      const settle = async () => {
        for (let i = 0; i < 5; i++)
          await React.act(async () => {
            await new Promise((r) => setTimeout(r, 40));
          });
      };
      const click = async (text: string) => {
        await React.act(async () => {
          const button = [
            ...dom.window.document.querySelectorAll('button'),
          ].find((b: any) => b.textContent === text);
          expect(button).toBeDefined();
          button.click();
        });
        await settle();
      };
      try {
        await React.act(async () =>
          root.render(
            React.createElement(component, {
              context: { scope: 'GLOBAL', userId: 'admin' },
              initiallyOpen: true,
            }),
          ),
        );
        await settle();
        await click('Conectar usando número de telefone');
        const input = dom.window.document.querySelector('input');
        const props =
          input[
            Object.keys(input).find((key) => key.startsWith('__reactProps'))!
          ];
        await React.act(async () =>
          props.onChange({ target: { value: '+55 (11) 99999-9999' } }),
        );
        await React.act(async () =>
          dom.window.document.querySelector('form').dispatchEvent(
            new dom.window.Event('submit', {
              bubbles: true,
              cancelable: true,
            }),
          ),
        );
        await settle();
        expect(dom.window.document.body.textContent).toContain('ABCD-1234');
        expect(
          calls.some(
            (c) =>
              c.path === '/instance/connect/kalend_global?number=5511999999999',
          ),
        ).toBe(true);
        remote.get('kalend_global')!.state = 'open';
        await click('Atualizar estado');
        await click('Desconectar WhatsApp');
        expect(dom.window.document.body.textContent).toContain(
          'WhatsApp desconectado',
        );
        await click('Reconectar');
        expect(remote.size).toBe(1);
        await click('Excluir conexão');
        expect(remote.size).toBe(0);
        await settle();
        expect(remote.size).toBe(0);
        expect(
          calls.some(
            (c) =>
              c.method === 'DELETE' &&
              c.path === '/instance/delete/kalend_global',
          ),
        ).toBe(true);
      } finally {
        await React.act(async () => root.unmount());
        dom.window.close();
        delete (globalThis as any).window;
        delete (globalThis as any).document;
        delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
      }
    },
  );
  it.skipIf(!availableWeb)(
    'cancels late company A responses when identity/tenant changes and never displays A QR for B',
    async () => {
      const dom = new JSDOM('<div id="root"></div>', {
        url: 'https://web.example.test',
      });
      Object.assign(globalThis, {
        window: dom.window,
        document: dom.window.document,
        IS_REACT_ACT_ENVIRONMENT: true,
      });
      const component = loadWeb(
        'components/evolution-settings.tsx',
        dom,
      ).EvolutionPanel;
      const root = createRoot(dom.window.document.getElementById('root'));
      browserUser = 'owner-a';
      delayResponse = true;
      try {
        await React.act(async () => {
          root.render(
            React.createElement(component, {
              key: 'a',
              context: { userId: 'owner-a', companyId: companyA },
              initiallyOpen: true,
            }),
          );
        });
        await React.act(async () => {
          await new Promise((r) => setTimeout(r, 100));
          dom.window.dispatchEvent(
            new dom.window.Event('kalend:tenant-changed'),
          );
        });
        browserUser = 'owner-b';
        delayResponse = false;
        await React.act(async () =>
          root.render(
            React.createElement(component, {
              key: 'b',
              context: { userId: 'owner-b', companyId: companyB },
              initiallyOpen: true,
            }),
          ),
        );
        for (let i = 0; i < 12; i++)
          await React.act(async () => {
            await new Promise((r) => setTimeout(r, 50));
          });
        expect(dom.window.document.querySelector('img')?.src).toBe(
          'data:image/png;base64,iVBORw0KGgoCAg==',
        );
        expect(
          [...f.rows.values()].find((r) => r.companyId === companyB)!
            .instanceName,
        ).toBe(evolutionInstanceName(companyB));
        expect(remote.has('kalend_global')).toBe(false);
      } finally {
        await React.act(async () => root.unmount());
        dom.window.close();
        delete (globalThis as any).window;
        delete (globalThis as any).document;
        delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
      }
    },
  );
});
