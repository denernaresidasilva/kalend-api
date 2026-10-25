import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { AuthConfig } from './auth.config.js';
import { AuthRateLimit } from './auth-rate-limit.service.js';
import { AuthService } from './auth.service.js';
import { AuthTokens } from './auth.tokens.js';

function setup() {
  const now = new Date();
  const tx = {
    plan: { findFirst: vi.fn().mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', name: 'Essencial', trialDays: 7 }) },
    user: { create: vi.fn().mockResolvedValue({ id: '22222222-2222-4222-8222-222222222222', name: 'Ana QA', email: 'ana@example.test' }) },
    company: { create: vi.fn().mockImplementation(({ data }) => ({ id: '33333333-3333-4333-8333-333333333333', ...data })) },
    membership: { create: vi.fn().mockResolvedValue({ id: 'membership' }) },
    subscription: { create: vi.fn().mockResolvedValue({ id: 'subscription', status: 'TRIALING', trialStartedAt: now, trialEndsAt: new Date(now.getTime() + 7 * 86400000) }) },
    publicSignupConsent: { create: vi.fn().mockResolvedValue({ id: 'consent' }) },
    globalCommunicationOutbox: { create: vi.fn().mockResolvedValue({ id: 'outbox' }) },
    authSession: { create: vi.fn().mockResolvedValue({ id: 'session', expiresAt: new Date(now.getTime() + 3600000), refreshExpiresAt: new Date(now.getTime() + 86400000) }) },
  };
  const db = { $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)) };
  const limiter = { consume: vi.fn().mockResolvedValue(undefined) };
  const service = new AuthService(db as never, new AuthTokens(new AuthConfig()), limiter as unknown as AuthRateLimit);
  const input = {
    companyName: 'Estúdio QA', ownerName: 'Ana QA', whatsapp: '+5511999999999',
    email: 'ana@example.test', password: 'Kalend-Segura-2026!', confirmPassword: 'Kalend-Segura-2026!',
    planId: '11111111-1111-4111-8111-111111111111', acceptTerms: true, marketingConsent: false,
    website: '', attribution: { utm_source: 'qa' },
  };
  return { service, db, tx, limiter, input };
}

describe('public trial signup', () => {
  beforeEach(() => vi.stubEnv('AUTH_JWT_SECRET', randomBytes(32).toString('hex')));
  afterEach(() => vi.unstubAllEnvs());

  it('atomically creates only a new owner, company, Trial, consent, email outbox and secure session', async () => {
    const { service, db, tx, limiter, input } = setup();
    const result = await service.trialSignup(input, '192.0.2.10');
    expect(db.$transaction).toHaveBeenCalledOnce();
    expect(tx.plan.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ isPublic: true, trialEnabled: true }) }));
    expect(tx.user.create.mock.calls[0][0].data).toMatchObject({ email: input.email, isSuperAdmin: false, isActive: true });
    expect(tx.company.create.mock.calls[0][0].data).toMatchObject({ status: 'TRIAL', isActive: true });
    expect(tx.membership.create.mock.calls[0][0].data.role).toBe('OWNER');
    expect(tx.subscription.create.mock.calls[0][0].data).toMatchObject({ status: 'TRIALING', gateway: 'MANUAL', trialStartedAt: expect.any(Date), trialEndsAt: expect.any(Date) });
    expect(tx.publicSignupConsent.create.mock.calls[0][0].data).toMatchObject({ marketingOptIn: false, attribution: { utm_source: 'qa' } });
    expect(tx.globalCommunicationOutbox.create.mock.calls[0][0].data).toMatchObject({ event: 'OWNER_WELCOME', variables: { __channels: ['EMAIL'] } });
    expect(tx.authSession.create.mock.calls[0][0].data.selectedCompanyId).toBe('33333333-3333-4333-8333-333333333333');
    expect(limiter.consume).toHaveBeenCalledTimes(2);
    expect(result.tokens.access).toEqual(expect.any(String));
    expect(JSON.stringify(result)).not.toContain('passwordHash');
  });

  it('rejects existing email uniqueness conflicts without issuing a session or attaching the company', async () => {
    const { service, tx, input } = setup();
    tx.user.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: '7.10.1' }));
    await expect(service.trialSignup(input, '192.0.2.11')).rejects.toThrow('PUBLIC_SIGNUP_REJECTED');
    expect(tx.company.create).not.toHaveBeenCalled();
    expect(tx.authSession.create).not.toHaveBeenCalled();
  });

  it('rejects password mismatch, unchecked terms and honeypot before any transaction', async () => {
    for (const changes of [{ confirmPassword: 'Different-password-2026!' }, { acceptTerms: false }, { website: 'bot' }]) {
      const { service, db, input } = setup();
      await expect(service.trialSignup({ ...input, ...changes }, '192.0.2.12')).rejects.toThrow();
      expect(db.$transaction).not.toHaveBeenCalled();
    }
  });

  it('does not enroll a plan without an active public trial', async () => {
    const { service, tx, input } = setup();
    tx.plan.findFirst.mockResolvedValue(null);
    await expect(service.trialSignup(input, '192.0.2.13')).rejects.toThrow('PUBLIC_SIGNUP_REJECTED');
    expect(tx.user.create).not.toHaveBeenCalled();
  });
});
