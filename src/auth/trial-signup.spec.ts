import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { AuthConfig } from './auth.config.js';
import { AuthRateLimit } from './auth-rate-limit.service.js';
import { AuthService } from './auth.service.js';
import { AuthTokens } from './auth.tokens.js';
import { parseLoginDto } from './auth.dto.js';

function setup() {
  const now = new Date();
  const tx = {
    plan: { findFirst: vi.fn().mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', name: 'Essencial', trialDays: 7 }) },
    user: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: '22222222-2222-4222-8222-222222222222', name: 'Ana QA', email: 'ana@example.test' }),
    },
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
  beforeEach(() => {
    vi.stubEnv('AUTH_JWT_SECRET', randomBytes(32).toString('hex'));
    vi.stubEnv('AUTH_ALLOWED_ORIGINS', 'https://dev.kalend.tech');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('normalizes email case and surrounding whitespace while preserving password bytes', () => {
    expect(parseLoginDto({ email: '  OWNER@EXAMPLE.TEST  ', password: '  keep exact  ' })).toEqual({
      email: 'owner@example.test', password: '  keep exact  ',
    });
  });

  it('atomically creates a new owner, company, Trial, consent and email outbox without a session', async () => {
    const { service, db, tx, limiter, input } = setup();
    const result = await service.trialSignup(input, '192.0.2.10', 'https://dev.kalend.tech');
    expect(db.$transaction).toHaveBeenCalledOnce();
    expect(tx.plan.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ isPublic: true, trialEnabled: true }) }));
    expect(tx.user.create.mock.calls[0][0].data).toMatchObject({ email: input.email, isSuperAdmin: false, isActive: true });
    expect(tx.company.create.mock.calls[0][0].data).toMatchObject({ status: 'TRIAL', isActive: true });
    expect(tx.membership.create.mock.calls[0][0].data.role).toBe('OWNER');
    expect(tx.subscription.create.mock.calls[0][0].data).toMatchObject({ status: 'TRIALING', gateway: 'MANUAL', trialStartedAt: expect.any(Date), trialEndsAt: expect.any(Date) });
    expect(tx.publicSignupConsent.create.mock.calls[0][0].data).toMatchObject({ marketingOptIn: false, attribution: { utm_source: 'qa' } });
    expect(tx.globalCommunicationOutbox.create.mock.calls[0][0].data).toMatchObject({ event: 'OWNER_WELCOME', variables: { __channels: ['EMAIL'], email_acesso: input.email, url_acesso: 'https://dev.kalend.tech/' } });
    expect(tx.authSession.create).not.toHaveBeenCalled();
    expect(limiter.consume).toHaveBeenCalledTimes(2);
    expect(result).not.toHaveProperty('tokens');
    expect(result).toHaveProperty('user.id');
    expect(JSON.stringify(result)).not.toContain('passwordHash');
  });

  it('rejects existing email uniqueness conflicts without issuing a session or attaching the company', async () => {
    const { service, tx, input } = setup();
    tx.user.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: '7.10.1' }));
    await expect(service.trialSignup(input, '192.0.2.11', 'https://dev.kalend.tech')).rejects.toThrow('PUBLIC_SIGNUP_REJECTED');
    expect(tx.company.create).not.toHaveBeenCalled();
    expect(tx.authSession.create).not.toHaveBeenCalled();
  });

  it('rejects password mismatch, unchecked terms and honeypot before any transaction', async () => {
    for (const changes of [{ confirmPassword: 'Different-password-2026!' }, { acceptTerms: false }, { website: 'bot' }]) {
      const { service, db, input } = setup();
      await expect(service.trialSignup({ ...input, ...changes }, '192.0.2.12', 'https://dev.kalend.tech')).rejects.toThrow();
      expect(db.$transaction).not.toHaveBeenCalled();
    }
  });

  it('does not enroll a plan without an active public trial', async () => {
    const { service, tx, input } = setup();
    tx.plan.findFirst.mockResolvedValue(null);
    await expect(service.trialSignup(input, '192.0.2.13', 'https://dev.kalend.tech')).rejects.toThrow('PUBLIC_SIGNUP_REJECTED');
    expect(tx.user.create).not.toHaveBeenCalled();
  });

  it.each([true, false])('keeps an existing identity (active=%s) reserved, even with no remaining company', async (isActive) => {
    const { service, tx, input } = setup();
    tx.user.findFirst.mockResolvedValue({ id: 'existing-user', isActive });
    await expect(service.trialSignup(input, '192.0.2.14', 'https://dev.kalend.tech')).rejects.toThrow('PUBLIC_SIGNUP_REJECTED');
    expect(tx.user.findFirst).toHaveBeenCalledWith({
      where: { email: { equals: input.email, mode: 'insensitive' } }, select: { id: true },
    });
    expect(tx.user.create).not.toHaveBeenCalled();
    expect(tx.company.create).not.toHaveBeenCalled();
    expect(tx.authSession.create).not.toHaveBeenCalled();
  });

  it('normalizes email before creating a genuinely new identity', async () => {
    const { service, tx, input } = setup();
    await service.trialSignup({ ...input, email: '  ANA@EXAMPLE.TEST  ' }, '192.0.2.15', 'https://dev.kalend.tech');
    expect(tx.user.findFirst).toHaveBeenCalledWith({
      where: { email: { equals: 'ana@example.test', mode: 'insensitive' } }, select: { id: true },
    });
    expect(tx.user.create.mock.calls[0][0].data.email).toBe('ana@example.test');
  });

  it('allows a genuinely deleted identity to register again when no user row exists', async () => {
    const { service, tx, input } = setup();
    tx.user.findFirst.mockResolvedValue(null);
    await expect(service.trialSignup(input, '192.0.2.16', 'https://dev.kalend.tech')).resolves.toHaveProperty('company.id');
    expect(tx.membership.create.mock.calls[0][0].data).toMatchObject({ userId: '22222222-2222-4222-8222-222222222222', role: 'OWNER' });
  });

  it('does not create a second company when concurrent or retried signup loses the unique identity race', async () => {
    const { service, tx, input } = setup();
    tx.user.create
      .mockResolvedValueOnce({ id: '22222222-2222-4222-8222-222222222222', name: 'Ana QA', email: input.email })
      .mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('duplicate normalized email', { code: 'P2002', clientVersion: '7.10.1' }));
    await expect(service.trialSignup(input, '192.0.2.17', 'https://dev.kalend.tech')).resolves.toHaveProperty('company.id');
    await expect(service.trialSignup(input, '192.0.2.18', 'https://dev.kalend.tech')).rejects.toThrow('PUBLIC_SIGNUP_REJECTED');
    expect(tx.company.create).toHaveBeenCalledOnce();
  });

  it('rejects a concurrent serializable identity conflict without leaking or creating another company', async () => {
    const { service, db, tx, input } = setup();
    const conflict = new Prisma.PrismaClientKnownRequestError('serialization conflict', {
      code: 'P2034', clientVersion: '7.10.1',
    });
    db.$transaction.mockRejectedValue(conflict);
    await expect(service.trialSignup(input, '192.0.2.19', 'https://dev.kalend.tech'))
      .rejects.toThrow('PUBLIC_SIGNUP_REJECTED');
    expect(tx.company.create).not.toHaveBeenCalled();
    expect(tx.authSession.create).not.toHaveBeenCalled();
  });

});
