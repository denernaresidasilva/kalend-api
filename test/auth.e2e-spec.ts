import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '../src/auth/auth.config.js';
import {
  authDatabase,
  ADMIN_ID,
  COMPANY_ID,
  OTHER_COMPANY_ID,
} from './support/auth-database.js';
const origin = 'https://dev.kalend.tech';
const password = 'test-only-password-123';
function cookie(response: request.Response, name: string) {
  const values = response.headers['set-cookie'] as unknown as string[];
  return values.find((c) => c.startsWith(`${name}=`))!.split(';')[0];
}
describe('authentication HTTP with real bcrypt/JWT and mock persistence', () => {
  let app: INestApplication;
  let fixture: ReturnType<typeof authDatabase>;
  beforeAll(async () => {
    vi.stubEnv('AUTH_JWT_SECRET', randomBytes(32).toString('hex'));
    vi.stubEnv('AUTH_ALLOWED_ORIGINS', origin);
    fixture = authDatabase(await bcrypt.hash(password, 12));
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(fixture.db)
      .compile();
    app = module.createNestApplication({ rawBody: true });
    await app.init();
  });
  beforeEach(() => fixture.reset());
  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });
  const login = (email = 'admin@example.test') =>
    request(app.getHttpServer())
      .post('/auth/login')
      .set('Origin', origin)
      .send({ email, password });
  it('logs in, sets secure HttpOnly cookies, and never returns tokens/hash in JSON', async () => {
    const response = await login().expect(200);
    expect(response.body.authenticated).toBe(true);
    expect(JSON.stringify(response.body)).not.toMatch(
      /password|token|access"|refresh"|secret/i,
    );
    for (const value of response.headers['set-cookie'] as unknown as string[]) {
      expect(value).toContain('HttpOnly');
      expect(value).toContain('Secure');
      expect(value).toContain('SameSite=Strict');
      expect(value).not.toContain('Domain=');
    }
    expect(response.headers['cache-control']).toBe('no-store');
    const rawRefresh = cookie(response, REFRESH_COOKIE).split('=')[1];
    expect(fixture.refreshes[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(fixture.refreshes[0].tokenHash).not.toBe(rawRefresh);
  });
  it('returns identical errors for wrong password and unknown user', async () => {
    const wrong = await request(app.getHttpServer())
      .post('/auth/login')
      .set('Origin', origin)
      .send({ email: 'admin@example.test', password: 'incorrect' })
      .expect(401);
    const unknown = await request(app.getHttpServer())
      .post('/auth/login')
      .set('Origin', origin)
      .send({ email: 'absent@example.test', password: 'incorrect' })
      .expect(401);
    expect(unknown.body).toEqual(wrong.body);
    expect(fixture.sessions).toHaveLength(0);
  });
  it('rejects inactive user even with correct password', async () => {
    fixture.users[0].isActive = false;
    await login().expect(401);
  });
  it('auth/me exposes global privilege independently of membership', async () => {
    const response = await login();
    const me = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Cookie', cookie(response, ACCESS_COOKIE))
      .expect(200);
    expect(me.body.user.id).toBe(ADMIN_ID);
    expect(me.body.systemRole).toBe('SUPER_ADMIN');
    expect(me.body.memberships).toEqual([]);
    expect(JSON.stringify(me.body)).not.toMatch(
      /passwordHash|tokenHash|secret/,
    );
  });
  it('represents multiple companies and per-company roles', async () => {
    const response = await login('member@example.test');
    const me = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Cookie', cookie(response, ACCESS_COOKIE))
      .expect(200);
    expect(me.body.systemRole).toBe('USER');
    expect(me.body.memberships.map((m: { role: string }) => m.role)).toEqual([
      'OWNER',
      'PROFESSIONAL',
    ]);
  });
  it.each([
    '/dashboard/summary',
    '/companies',
    '/plans',
    '/subscriptions',
    '/finance',
    '/payment-gateways',
    '/users',
    '/webhooks',
  ])('%s requires authentication and global privilege', async (path) => {
    await request(app.getHttpServer()).get(path).expect(401);
    const response = await login('member@example.test');
    await request(app.getHttpServer())
      .get(path)
      .set('Cookie', cookie(response, ACCESS_COOKIE))
      .expect(403);
  });
  it('allows Super Admin without company membership', async () => {
    const response = await login();
    await request(app.getHttpServer())
      .get('/payment-gateways')
      .set('Cookie', cookie(response, ACCESS_COOKIE))
      .expect(200);
  });
  it.each([
    ['post', '/companies/manual'],
    ['post', '/plans'],
    ['patch', '/plans/11111111-1111-4111-8111-111111111111'],
    ['patch', '/payment-gateways/STRIPE'],
    ['post', '/payment-gateways/STRIPE/test'],
    ['post', '/payments'],
    ['post', '/billing/reconcile'],
    ['post', '/webhooks/11111111-1111-4111-8111-111111111111/reprocess'],
  ])('protects %s %s', async (method, path) => {
    const agent = request(app.getHttpServer());
    await (method === 'patch' ? agent.patch(path) : agent.post(path))
      .set('Origin', origin)
      .send({})
      .expect(401);
  });
  it('refresh rotates; replay revokes entire session including newly issued access', async () => {
    const first = await login();
    const firstRefresh = cookie(first, REFRESH_COOKIE);
    const second = await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Origin', origin)
      .set('Cookie', firstRefresh)
      .send({})
      .expect(200);
    expect(cookie(second, REFRESH_COOKIE)).not.toBe(firstRefresh);
    expect(fixture.refreshes).toHaveLength(2);
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Origin', origin)
      .set('Cookie', firstRefresh)
      .send({})
      .expect(401);
    expect(fixture.sessions[0].revokedAt).toBeInstanceOf(Date);
    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Cookie', cookie(second, ACCESS_COOKIE))
      .expect(401);
  });
  it('logout revokes refresh and access and clears cookies', async () => {
    const first = await login();
    const cookies = [
      cookie(first, ACCESS_COOKIE),
      cookie(first, REFRESH_COOKIE),
    ];
    const out = await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Origin', origin)
      .set('Cookie', cookies)
      .send({})
      .expect(204);
    expect(out.headers['set-cookie']).toHaveLength(2);
    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Cookie', cookies)
      .expect(401);
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Origin', origin)
      .set('Cookie', cookies)
      .send({})
      .expect(401);
  });
  it('isolates devices and supports logout-all', async () => {
    const first = await login();
    const second = await login();
    expect(fixture.sessions).toHaveLength(2);
    await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Origin', origin)
      .set('Cookie', cookie(first, REFRESH_COOKIE))
      .send({})
      .expect(204);
    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Cookie', cookie(second, ACCESS_COOKIE))
      .expect(200);
    await request(app.getHttpServer())
      .post('/auth/logout-all')
      .set('Origin', origin)
      .set('Cookie', cookie(second, ACCESS_COOKIE))
      .send({})
      .expect(204);
    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Cookie', cookie(second, ACCESS_COOKIE))
      .expect(401);
  });
  it('rejects expired session and expired refresh', async () => {
    const response = await login();
    fixture.sessions[0].expiresAt = new Date(0);
    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Cookie', cookie(response, ACCESS_COOKIE))
      .expect(401);
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Origin', origin)
      .set('Cookie', cookie(response, REFRESH_COOKIE))
      .send({})
      .expect(401);
  });
  it('rejects individually expired refresh while absolute session is still valid', async () => {
    const response = await login();
    fixture.refreshes[0].expiresAt = new Date(0);
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Origin', origin)
      .set('Cookie', cookie(response, REFRESH_COOKIE))
      .send({})
      .expect(401);
    expect(fixture.sessions[0].revokedAt).toBeInstanceOf(Date);
  });
  it('reads privilege changes and deactivation from database immediately', async () => {
    const response = await login();
    fixture.users[0].isSuperAdmin = false;
    await request(app.getHttpServer())
      .get('/payment-gateways')
      .set('Cookie', cookie(response, ACCESS_COOKIE))
      .expect(403);
    fixture.users[0].isActive = false;
    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Cookie', cookie(response, ACCESS_COOKIE))
      .expect(401);
  });
  it('invalidates access and refresh after password changes', async () => {
    const response = await login();
    fixture.users[0].passwordHash = await bcrypt.hash(
      'another-test-only-password',
      12,
    );
    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Cookie', cookie(response, ACCESS_COOKIE))
      .expect(401);
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Origin', origin)
      .set('Cookie', cookie(response, REFRESH_COOKIE))
      .send({})
      .expect(401);
    expect(fixture.sessions[0].revokedAt).toBeInstanceOf(Date);
  });
  it('rejects mass assignment and malicious/missing Origin', async () => {
    await request(app.getHttpServer())
      .post('/auth/login')
      .set('Origin', origin)
      .send({ email: 'member@example.test', password, isSuperAdmin: true })
      .expect(400);
    await request(app.getHttpServer())
      .post('/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ email: 'member@example.test', password })
      .expect(403);
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'member@example.test', password })
      .expect(403);
    expect(fixture.sessions).toHaveLength(0);
  });
  it('rejects cross-tenant selection and arbitrary headers', async () => {
    const response = await login('member@example.test');
    const access = cookie(response, ACCESS_COOKIE);
    await request(app.getHttpServer())
      .post('/auth/tenant')
      .set('Origin', origin)
      .set('Cookie', access)
      .send({ companyId: '55555555-5555-4555-8555-555555555555' })
      .expect(403);
    await request(app.getHttpServer())
      .get('/auth/tenant')
      .set('Cookie', access)
      .set('X-Company-Id', COMPANY_ID)
      .expect(403);
    expect(fixture.sessions[0].selectedCompanyId).toBeNull();
    await request(app.getHttpServer())
      .post('/auth/tenant')
      .set('Origin', origin)
      .set('Cookie', access)
      .send({ companyId: COMPANY_ID })
      .expect(200);
    const tenant = await request(app.getHttpServer())
      .get('/auth/tenant')
      .set('Cookie', access)
      .set('X-Company-Id', OTHER_COMPANY_ID)
      .expect(200);
    expect(tenant.body.companyId).toBe(COMPANY_ID);
    fixture.memberships[0].isActive = false;
    await request(app.getHttpServer())
      .get('/auth/tenant')
      .set('Cookie', access)
      .expect(403);
  });
  it('does not grant tenant membership to global Super Admin implicitly', async () => {
    const response = await login();
    await request(app.getHttpServer())
      .post('/auth/tenant')
      .set('Origin', origin)
      .set('Cookie', cookie(response, ACCESS_COOKIE))
      .send({ companyId: COMPANY_ID })
      .expect(403);
  });
  it('blocks CSRF on authenticated administrative writes', async () => {
    const response = await login();
    await request(app.getHttpServer())
      .post('/billing/reconcile')
      .set('Cookie', cookie(response, ACCESS_COOKIE))
      .set('Origin', 'https://other.kalend.tech')
      .send({})
      .expect(403);
  });
  it('returns 429 before creating a session when the IP budget is exhausted', async () => {
    fixture.db.authRateLimit.upsert.mockResolvedValueOnce({ attempts: 31 });
    await login().expect(429);
    expect(fixture.sessions).toHaveLength(0);
  });
  it.each(['mercado-pago', 'stripe', 'pagbank'])(
    'external %s receiver does not require administrative JWT',
    async (gateway) => {
      const result = await request(app.getHttpServer())
        .post(`/webhooks/${gateway}`)
        .send({})
        .expect(503);
      expect(result.body.message).toBe('GATEWAY_ADAPTER_PENDING');
    },
  );
  it('keeps public plans public', async () => {
    await request(app.getHttpServer()).get('/plans/public').expect(200);
  });
});
