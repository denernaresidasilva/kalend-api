import { randomBytes } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import request from 'supertest';
import { EmailService, emailInput, EMAIL_PROVIDERS } from './email.js';
import type { EmailContext } from './email.js';
import {
  SystemEmailController,
  CompanyEmailController,
} from './email.controller.js';
import { SecretVault } from '../billing/secret-vault.js';
import { SmtpTransport } from './transports.js';
import { TransportFailure } from './contracts.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuthService } from '../auth/auth.service.js';
import { AuthConfig, ACCESS_COOKIE } from '../auth/auth.config.js';
import { AuthRateLimit } from '../auth/auth-rate-limit.service.js';
import { AdminGuard } from '../common/admin.guard.js';
import { TenantGuard } from '../auth/tenant.guard.js';

const system: EmailContext = { scope: 'SYSTEM' };
const a: EmailContext = { scope: 'COMPANY', companyId: 'company-a' };
const b: EmailContext = { scope: 'COMPANY', companyId: 'company-b' };
const body = {
  provider: 'GOOGLE',
  email: 'sender@gmail.com',
  smtpHost: 'smtp.gmail.com',
  smtpPort: 587,
  security: 'TLS',
  password: 'app-secret-test-only',
};
function setup() {
  type Row = Record<string, unknown>;
  const global = new Map<string, Row>(),
    companies = new Map<string, Row>(),
    attempts = new Map<string, number>();
  function repository(rows: Map<string, Row>, key: string) {
    return {
      findUnique: vi.fn(async ({ where }) => rows.get(where[key]) ?? null),
      upsert: vi.fn(async ({ where, create, update }) => {
        const old = rows.get(where[key]);
        const row = old
          ? { ...old, ...update, revision: Number(old.revision) + 1 }
          : { revision: 1, ...create };
        rows.set(where[key], row);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        const old = rows.get(where[key]);
        if (
          !old ||
          (where.revision !== undefined && old.revision !== where.revision)
        )
          return { count: 0 };
        rows.set(where[key], {
          ...old,
          ...data,
          revision: data.revision ? Number(old.revision) + 1 : old.revision,
        });
        return { count: 1 };
      }),
    };
  }
  const db = {
    globalCommunicationProvider: repository(global, 'provider'),
    companyEmailConfiguration: repository(companies, 'companyId'),
    company: {
      findUniqueOrThrow: vi.fn(async ({ where }) => ({
        name: `Empresa ${where.id}`,
      })),
    },
    authRateLimit: {
      upsert: vi.fn(async ({ where }) => {
        const value = (attempts.get(where.key) ?? 0) + 1;
        attempts.set(where.key, value);
        return { attempts: value };
      }),
    },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation((fn) => fn(db));
  const smtp = { send: vi.fn().mockResolvedValue('test-id') };
  const service = new EmailService(
    db as never,
    new SecretVault(),
    smtp as never,
  );
  return { db, smtp, service, global, companies };
}
beforeEach(() => {
  vi.stubEnv('GATEWAY_ENCRYPTION_KEY', randomBytes(32).toString('hex'));
  vi.stubEnv('COMMUNICATION_SMTP_HOSTS', 'smtp.custom.test');
});
afterEach(() => vi.unstubAllEnvs());

describe('SMTP email lifecycle and strict scopes', () => {
  it('saves encrypted global and tenant credentials, never exposes secrets and preserves an omitted password', async () => {
    const { service, global, companies } = setup();
    for (const ctx of [system, a, b]) {
      const saved = await service.save(ctx, body);
      expect(saved).toMatchObject({
        configured: true,
        verified: false,
        status: 'UNTESTED',
        enabled: false,
      });
      expect(JSON.stringify(saved)).not.toMatch(
        /password|secret|credentialsEncrypted/,
      );
    }
    const globalSecret = global.get('SMTP')!.credentialsEncrypted as string;
    const tenantSecret = companies.get('company-a')!
      .credentialsEncrypted as string;
    expect(globalSecret).not.toContain(body.password);
    expect(tenantSecret).not.toBe(globalSecret);
    expect(() =>
      new SecretVault().decrypt(
        tenantSecret,
        'communication:COMPANY:company-b:SMTP:credentials',
      ),
    ).toThrow();
    const { password: _, ...update } = body;
    await service.save(a, update);
    expect(companies.get('company-a')!.credentialsEncrypted).toBe(tenantSecret);
    await expect(
      service.save(a, { ...update, email: 'new@gmail.com' }),
    ).rejects.toThrow('EMAIL_PASSWORD_REQUIRED');
    await service.save(a, { ...body, password: 'replacement' });
    expect(companies.get('company-a')!.credentialsEncrypted).not.toBe(
      tenantSecret,
    );
  });
  it('activating system SMTP disables GLOBAL Gmail without changing company SMTP', async () => {
    const { service, db, global, companies } = setup();
    await service.save(system, body);
    await service.save(a, body);
    global.set('GMAIL', {
      provider: 'GMAIL',
      scope: 'GLOBAL',
      enabled: true,
      revision: 1,
    });
    await service.test(system, { recipient: 'admin@example.test' });
    const { password: _, ...update } = body;
    await service.save(system, { ...update, enabled: true });
    expect(global.get('SMTP')?.enabled).toBe(true);
    expect(global.get('GMAIL')?.enabled).toBe(false);
    expect(companies.get('company-a')?.enabled).toBe(false);
    expect(db.globalCommunicationProvider.updateMany).toHaveBeenCalledWith({
      where: { scope: 'GLOBAL', provider: 'GMAIL', enabled: true },
      data: { enabled: false, revision: { increment: 1 } },
    });
  });
  it('requires a successful real test before enabling, resets validation on edits and deletes only the selected company', async () => {
    const { service, smtp } = setup();
    await service.save(a, body);
    await service.save(b, body);
    const { password: _, ...update } = body;
    await expect(service.save(a, { ...update, enabled: true })).rejects.toThrow(
      'EMAIL_SEND_TEST_REQUIRED',
    );
    await service.test(a, { recipient: 'test@example.test' });
    await service.save(a, { ...update, enabled: true });
    await service.send(a, {
      to: 'client@example.test',
      subject: 'Hello',
      text: 'Hello',
    });
    expect(smtp.send).toHaveBeenCalledTimes(2);
    await service.save(a, body);
    expect(await service.get(a)).toMatchObject({
      enabled: false,
      verified: false,
      status: 'UNTESTED',
      lastTestAt: null,
    });
    await service.remove(a);
    expect(await service.get(a)).toMatchObject({
      configured: false,
      smtpHost: '',
      status: 'NOT_CONFIGURED',
    });
    expect((await service.get(b)).configured).toBe(true);
  });
  it('never falls back from an unconfigured company to global SMTP', async () => {
    const { service, smtp } = setup();
    await service.save(system, body);
    await expect(
      service.test(a, { recipient: 'test@example.test' }),
    ).rejects.toThrow('EMAIL_NOT_CONFIGURED');
    await expect(
      service.send(a, { to: 'test@example.test', text: 'Hello' }),
    ).rejects.toThrow('EMAIL_NOT_CONFIGURED');
    expect(smtp.send).not.toHaveBeenCalled();
  });
  it('selects each sender explicitly and sends a real message with scope identification without campaigns', async () => {
    const { service, smtp } = setup();
    for (const ctx of [system, a, b]) {
      await service.save(ctx, {
        ...body,
        password: ctx.scope === 'SYSTEM' ? 'global-pass' : ctx.companyId,
      });
      const result = await service.test(ctx, {
        recipient: 'recipient@example.test',
      });
      expect(result).toMatchObject({
        sent: true,
        tls: true,
        server: 'smtp.gmail.com:587',
        configuration: {
          verified: true,
          lastTestRecipient: 'recipient@example.test',
        },
      });
      const [config, secret, message] = smtp.send.mock.lastCall!;
      expect(config.host).toBe('smtp.gmail.com');
      expect(secret.password).toBe(
        ctx.scope === 'SYSTEM' ? 'global-pass' : ctx.companyId,
      );
      expect(message.subject).toBe('Teste de e-mail — Kalend');
      expect(message.text).toContain(
        ctx.scope === 'SYSTEM' ? 'sistema Kalend' : `Empresa ${ctx.companyId}`,
      );
    }
  });
  it.each([
    new TransportFailure('AUTH'),
    new TransportFailure('UNCERTAIN'),
    new Error('password=private SMTP response token=secret'),
  ])(
    'sanitizes authentication, timeout and arbitrary provider errors (%s)',
    async (failure) => {
      const { service, smtp } = setup();
      await service.save(a, body);
      smtp.send.mockRejectedValue(failure);
      const result = await service.test(a, { recipient: 'test@example.test' });
      expect(result).toMatchObject({
        sent: false,
        configuration: { status: 'ERROR', verified: false, enabled: false },
      });
      expect(JSON.stringify(result)).not.toMatch(
        /private|password|token=|secret/,
      );
    },
  );
  it('cannot validate a revision changed during the SMTP send', async () => {
    const { service, smtp } = setup();
    await service.save(a, body);
    smtp.send.mockImplementation(async () => {
      await service.save(a, body);
      return 'id';
    });
    await expect(
      service.test(a, { recipient: 'test@example.test' }),
    ).rejects.toThrow('CONFIGURATION_CHANGED');
    expect((await service.get(a)).verified).toBe(false);
  });
  it.each(Object.entries(EMAIL_PROVIDERS))(
    'supports %s provider and defaults agreed with Web',
    (provider, host) => {
      expect(
        emailInput({ ...body, provider, smtpHost: host || 'smtp.custom.test' })
          .config,
      ).toMatchObject({
        emailProvider: provider,
        port: '587',
        secure: 'false',
      });
    },
  );
  it('accepts SSL and rejects plaintext, wrong ports, unknown fields, recipients lists and private hosts', async () => {
    expect(
      emailInput({ ...body, smtpPort: 465, security: 'SSL' }).config.secure,
    ).toBe('true');
    for (const patch of [
      { security: 'NONE' },
      { smtpPort: 25 },
      { smtpPort: '587' },
      { security: 'SSL' },
      { companyId: 'company-b' },
      { provider: 'BAD' },
      { smtpHost: 'localhost' },
      { smtpHost: '127.0.0.1' },
      { smtpHost: 'unauthorized.test' },
    ])
      expect(() => emailInput({ ...body, ...patch })).toThrow();
    const { service, smtp } = setup();
    await expect(
      service.test(a, { recipient: 'a@test.com,b@test.com' }),
    ).rejects.toThrow();
    expect(smtp.send).not.toHaveBeenCalled();
  });
});

describe('SMTP HTTP guards, tenant session and shared database rate limits', () => {
  async function appSetup() {
    const data = setup();
    const auth = {
      authenticate: vi.fn(async (cookie: string | undefined) => {
        if (!cookie) throw new UnauthorizedException();
        return {
          user: {
            id: cookie,
            isSuperAdmin: cookie === 'super',
            isActive: true,
          },
          session: {
            selectedCompanyId: cookie.endsWith('-b')
              ? 'company-b'
              : 'company-a',
          },
        };
      }),
      membership: vi.fn(async (userId: string, companyId: string) => {
        if (userId === 'outsider') throw new ForbiddenException();
        return {
          id: `${userId}:${companyId}`,
          role: userId.split('-')[0].toUpperCase(),
        };
      }),
    };
    const config = {
      origins: () => ['https://web.test'],
      key: () => Buffer.alloc(32, 1),
    };
    const module = await Test.createTestingModule({
      controllers: [SystemEmailController, CompanyEmailController],
      providers: [
        EmailService,
        SecretVault,
        AuthRateLimit,
        AdminGuard,
        TenantGuard,
        { provide: PrismaService, useValue: data.db },
        { provide: SmtpTransport, useValue: data.smtp },
        { provide: AuthService, useValue: auth },
        { provide: AuthConfig, useValue: config },
      ],
    }).compile();
    const app = module.createNestApplication();
    await app.init();
    return { app, ...data };
  }
  it('persists global PUT through authentication and AdminGuard, then reloads without secrets', async () => {
    const { app, global, db } = await appSetup();
    try {
      const server = app.getHttpServer();
      const empty = await request(server)
        .get('/communication/email')
        .set('Cookie', `${ACCESS_COOKIE}=super`)
        .expect(200);
      expect(empty.body).toMatchObject({
        configured: false,
        hasPassword: false,
        email: '',
        smtpHost: '',
      });
      await request(server)
        .put('/communication/email')
        .set('Origin', 'https://web.test')
        .send(body)
        .expect(401);
      await request(server)
        .put('/communication/email')
        .set('Cookie', `${ACCESS_COOKIE}=owner`)
        .set('Origin', 'https://web.test')
        .send(body)
        .expect(403);
      await request(server)
        .put('/communication/email')
        .set('Cookie', `${ACCESS_COOKIE}=super`)
        .set('Origin', 'https://web.test')
        .send({ ...body, smtpPort: 25 })
        .expect(400);
      const saved = await request(server)
        .put('/communication/email')
        .set('Cookie', `${ACCESS_COOKIE}=super`)
        .set('Origin', 'https://web.test')
        .send(body)
        .expect(200);
      expect(saved.body).toMatchObject({
        configured: true,
        hasPassword: true,
        email: body.email,
        smtpHost: body.smtpHost,
      });
      expect(saved.body).not.toHaveProperty('password');
      expect(saved.body).not.toHaveProperty('credentialsEncrypted');
      const encrypted = global.get('SMTP')!.credentialsEncrypted as string;
      expect(encrypted).not.toContain(body.password);
      expect(db.$transaction).toHaveBeenCalled();
      const reloaded = await request(server)
        .get('/communication/email')
        .set('Cookie', `${ACCESS_COOKIE}=super`)
        .expect(200);
      expect(reloaded.body).toEqual(saved.body);
      const { password: _, ...update } = body;
      await request(server)
        .put('/communication/email')
        .set('Cookie', `${ACCESS_COOKIE}=super`)
        .set('Origin', 'https://web.test')
        .send(update)
        .expect(200);
      expect(global.get('SMTP')!.credentialsEncrypted).toBe(encrypted);
      await request(server)
        .put('/communication/email')
        .set('Cookie', `${ACCESS_COOKIE}=super`)
        .set('Origin', 'https://web.test')
        .send({ ...body, password: 'replacement-test-only' })
        .expect(200);
      const replacement = global.get('SMTP')!.credentialsEncrypted as string;
      expect(replacement).not.toBe(encrypted);
      expect(
        JSON.parse(
          new SecretVault().decrypt(
            replacement,
            'communication:GLOBAL:SMTP:PRODUCTION:credentials',
          ),
        ),
      ).toEqual({ password: 'replacement-test-only' });
      const again = await request(server)
        .get('/communication/email')
        .set('Cookie', `${ACCESS_COOKIE}=super`)
        .expect(200);
      expect(again.body).toEqual(saved.body);
    } finally {
      await app.close();
    }
  });
  it('authorizes only Super Admin globally and OWNER/ADMIN for the current company', async () => {
    const { app } = await appSetup();
    try {
      for (const role of [
        'owner',
        'admin',
        'professional',
        'client',
        'receptionist',
        'outsider',
        'super',
      ]) {
        await request(app.getHttpServer())
          .get('/communication/email')
          .set('Cookie', `${ACCESS_COOKIE}=${role}`)
          .expect(role === 'super' ? 200 : 403);
        await request(app.getHttpServer())
          .get('/company/communication/email')
          .set('Cookie', `${ACCESS_COOKIE}=${role}`)
          .expect(['owner', 'admin'].includes(role) ? 200 : 403);
      }
      await request(app.getHttpServer())
        .get('/communication/email')
        .expect(401);
      await request(app.getHttpServer())
        .put('/company/communication/email')
        .set('Cookie', `${ACCESS_COOKIE}=owner`)
        .send(body)
        .expect(403);
    } finally {
      await app.close();
    }
  });
  it('keeps company A, company B and global independent across GET/PUT/DELETE and prevents supplied tenant IDs', async () => {
    const { app, service } = await appSetup();
    try {
      await service.save(system, body);
      for (const actor of ['owner-a', 'owner-b'])
        await request(app.getHttpServer())
          .put('/company/communication/email')
          .set('Cookie', `${ACCESS_COOKIE}=${actor}`)
          .set('Origin', 'https://web.test')
          .send({ ...body, email: `${actor}@test.com` })
          .expect(200);
      for (const actor of ['owner-a', 'owner-b']) {
        const r = await request(app.getHttpServer())
          .get('/company/communication/email')
          .set('Cookie', `${ACCESS_COOKIE}=${actor}`)
          .expect(200);
        expect(r.body.email).toBe(`${actor}@test.com`);
        expect(JSON.stringify(r.body)).not.toMatch(
          /password|credentialsEncrypted/,
        );
      }
      await request(app.getHttpServer())
        .put('/company/communication/email')
        .set('Cookie', `${ACCESS_COOKIE}=owner-a`)
        .set('Origin', 'https://web.test')
        .send({ ...body, companyId: 'company-b' })
        .expect(400);
      await request(app.getHttpServer())
        .delete('/company/communication/email')
        .set('Cookie', `${ACCESS_COOKIE}=owner-a`)
        .set('Origin', 'https://web.test')
        .expect(200);
      expect((await service.get(b)).configured).toBe(true);
      expect((await service.get(system)).configured).toBe(true);
    } finally {
      await app.close();
    }
  });
  it('sends a real mocked SMTP message and blocks the sixth test before the transport', async () => {
    const { app, service, smtp } = await appSetup();
    await service.save(a, body);
    try {
      for (let i = 0; i < 6; i++)
        await request(app.getHttpServer())
          .post('/company/communication/email/test')
          .set('Cookie', `${ACCESS_COOKIE}=owner-a`)
          .set('Origin', 'https://web.test')
          .send({ recipient: 'test@example.test' })
          .expect(i < 5 ? 201 : 429);
      expect(smtp.send).toHaveBeenCalledTimes(5);
      await request(app.getHttpServer())
        .post('/company/communication/email/test')
        .set('Cookie', `${ACCESS_COOKIE}=admin-a`)
        .set('Origin', 'https://web.test')
        .send({ recipient: 'test@example.test' })
        .expect(429);
      expect(smtp.send).toHaveBeenCalledTimes(5);
    } finally {
      await app.close();
    }
  });
});

describe('SMTP compatibility with existing global configurations', () => {
  it('preserves legacy sender, replyTo, provider, environment and secret through save/test/enable', async () => {
    const { service, global, smtp } = setup();
    const credentialsEncrypted = new SecretVault().encrypt(
      JSON.stringify({ password: 'legacy-password' }),
      'communication:GLOBAL:SMTP:SANDBOX:credentials',
    );
    global.set('SMTP', {
      provider: 'SMTP',
      scope: 'GLOBAL',
      environment: 'SANDBOX',
      enabled: true,
      status: 'CONNECTED',
      revision: 1,
      lastVerifiedAt: new Date(),
      config: {
        host: ' SMTP.GMAIL.COM ',
        port: 587,
        secure: false,
        username: 'sender@gmail.com',
        fromName: 'Minha marca',
        fromEmail: ' SENDER@GMAIL.COM ',
        replyTo: ' REPLY@EXAMPLE.TEST ',
        emailProvider: 'google',
      },
      credentialsEncrypted,
    });
    expect(await service.get(system)).toMatchObject({
      enabled: false,
      verified: false,
      status: 'UNTESTED',
      lastTestAt: null,
      provider: 'GOOGLE',
    });
    const { password: _, ...update } = body;
    await service.save(system, update);
    expect(global.get('SMTP')!.config).toMatchObject({
      fromName: 'Minha marca',
      replyTo: 'reply@example.test',
      emailProvider: 'GOOGLE',
    });
    expect(global.get('SMTP')!.credentialsEncrypted).toBe(credentialsEncrypted);
    await service.test(system, { recipient: 'test@example.test' });
    const testAt = (await service.get(system)).lastTestAt;
    expect(testAt).toBeInstanceOf(Date);
    await service.save(system, { ...update, enabled: true });
    expect(await service.get(system)).toMatchObject({
      enabled: true,
      verified: true,
      lastTestStatus: 'SUCCESS',
      lastTestAt: testAt,
    });
    expect(smtp.send).toHaveBeenCalledWith(
      expect.objectContaining({
        fromName: 'Minha marca',
        replyTo: 'reply@example.test',
        emailProvider: 'GOOGLE',
      }),
      { password: 'legacy-password' },
      expect.anything(),
    );
    expect(global.get('SMTP')!.environment).toBe('SANDBOX');
  });
  it('normalizes a missing provider without invalidating an accepted real test', async () => {
    const { service, global } = setup();
    await service.save(system, body);
    await service.test(system, { recipient: 'test@example.test' });
    const config = {
      ...(global.get('SMTP')!.config as Record<string, unknown>),
    };
    delete config.emailProvider;
    global.get('SMTP')!.config = config;
    const { password: _, ...update } = body;
    await service.save(system, { ...update, enabled: true });
    expect(await service.get(system)).toMatchObject({
      enabled: true,
      verified: true,
      provider: 'GOOGLE',
    });
  });
  it('records ERROR and attempt time after a previously accepted test, and requires a new successful send', async () => {
    const { service, smtp } = setup();
    await service.save(a, body);
    await service.test(a, { recipient: 'test@example.test' });
    smtp.send.mockRejectedValue(new TransportFailure('AUTH'));
    const failed = await service.test(a, { recipient: 'failed@example.test' });
    expect(failed.configuration).toMatchObject({
      lastTestStatus: 'ERROR',
      lastTestRecipient: 'failed@example.test',
      enabled: false,
      verified: false,
    });
    expect(failed.configuration.lastTestAt).toBeInstanceOf(Date);
    const { password: _, ...update } = body;
    await expect(service.save(a, { ...update, enabled: true })).rejects.toThrow(
      'EMAIL_SEND_TEST_REQUIRED',
    );
  });
  it.each(['GOOGLE', 'MICROSOFT', 'ICLOUD'] as const)(
    'accepts official %s without a manual allowlist',
    (provider) => {
      vi.stubEnv('COMMUNICATION_SMTP_HOSTS', '');
      expect(() =>
        emailInput({ ...body, provider, smtpHost: EMAIL_PROVIDERS[provider] }),
      ).not.toThrow();
      expect(() =>
        emailInput({
          ...body,
          provider: 'CUSTOM',
          smtpHost: 'smtp.custom.test',
        }),
      ).toThrow('SMTP_HOST_NOT_ALLOWED');
    },
  );
});
it('preserves legacy configuration even when its secret has not been supplied yet', async () => {
  const { service, global } = setup();
  global.set('SMTP', {
    revision: 1,
    environment: 'SANDBOX',
    config: {
      host: 'smtp.gmail.com',
      port: '587',
      secure: 'false',
      username: 'sender@gmail.com',
      fromEmail: 'sender@gmail.com',
      fromName: 'Minha marca',
      replyTo: 'reply@example.test',
      emailProvider: 'GOOGLE',
    },
    credentialsEncrypted: null,
  });
  expect(await service.get(system)).toMatchObject({
    configured: false,
    smtpHost: 'smtp.gmail.com',
    provider: 'GOOGLE',
  });
  await service.save(system, body);
  expect(global.get('SMTP')!.config).toMatchObject({
    fromName: 'Minha marca',
    replyTo: 'reply@example.test',
    emailProvider: 'GOOGLE',
  });
});
it('an operator removing a custom host from the allowlist does not prevent reading or removing its configuration', async () => {
  const { service } = setup();
  await service.save(a, {
    ...body,
    provider: 'CUSTOM',
    smtpHost: 'smtp.custom.test',
  });
  vi.stubEnv('COMMUNICATION_SMTP_HOSTS', '');
  expect(await service.get(a)).toMatchObject({
    smtpHost: 'smtp.custom.test',
    configured: true,
  });
  await expect(
    service.test(a, { recipient: 'test@example.test' }),
  ).rejects.toThrow('SMTP_HOST_NOT_ALLOWED');
  expect((await service.remove(a)).configured).toBe(false);
});
