import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import {
  administrativelyActive,
  assertAdministrativeAccess,
} from '../billing/company-policy.js';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '@prisma/client';
import { normalizeBrazilianPhone } from '../communication/recipient.js';
import { parseLoginDto, parseSelectTenantDto } from './auth.dto.js';
import {
  AuthTokens,
  credentialHash,
  newRefresh,
  refreshHash,
  validRefresh,
} from './auth.tokens.js';
import {
  ACCESS_SECONDS,
  REFRESH_SECONDS,
  SESSION_SECONDS,
} from './auth.config.js';
import { AuthRateLimit } from './auth-rate-limit.service.js';
import { boolean, object, string, uuid } from '../common/validation.js';
import type { AuthIdentity } from './auth.types.js';
import {
  entitledWhere,
  effectiveAccessStatus,
} from '../billing/commercial-policy.js';
const identitySelect = {
  id: true,
  name: true,
  email: true,
  isActive: true,
  isSuperAdmin: true,
} as const;
const membershipSelect = {
  id: true,
  role: true,
  isActive: true,
  companyId: true,
  company: {
    select: {
      id: true,
      name: true,
      slug: true,
      status: true,
      isActive: true,
      administrativeStatus: true,
    },
  },
} as const;
@Injectable()
export class AuthService {
  // Same bcrypt work for a nonexistent identity. Random dummy secret is never persisted or logged.
  private readonly dummyHash = bcrypt.hash(randomBytes(32).toString('hex'), 12);
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthTokens) private readonly tokens: AuthTokens,
    @Inject(AuthRateLimit) private readonly limiter: AuthRateLimit,
  ) {}
  private noActiveCompany() {
    return new ForbiddenException({
      code: 'NO_ACTIVE_COMPANY',
      message: 'Esta conta não possui uma empresa vinculada.',
    });
  }
  // Authentication eligibility is not commercial entitlement: an OWNER with
  // an active membership can enter recovery even when the company is irregular.
  private async hasAuthenticationMembership(
    userId: string,
    client: Pick<PrismaService, 'membership'> = this.prisma,
  ) {
    const memberships = await client.membership.findMany({
      where: { userId, isActive: true },
      select: {
        role: true,
        company: {
          select: { status: true, isActive: true, administrativeStatus: true },
        },
      },
    });
    return memberships.some(
      (membership) =>
        administrativelyActive(membership.company) &&
        (membership.role === 'OWNER' ||
          ((membership.company.status === 'ACTIVE' ||
            membership.company.status === 'TRIAL') &&
            membership.company.isActive) ||
          membership.company.status === 'SUSPENDED' ||
          membership.company.status === 'CANCELED'),
    );
  }
  async login(input: unknown, ip: string) {
    const data = parseLoginDto(input);
    const email = data.email;
    await this.limiter.consume('login-ip', ip, 30, 900);
    await this.limiter.consume('login-email', email, 10, 900);
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { ...identitySelect, passwordHash: true },
    });
    const dummy = await this.dummyHash;
    const correct = await bcrypt.compare(
      data.password,
      user?.passwordHash ?? dummy,
    );
    if (!user || !correct)
      throw new UnauthorizedException('E-mail ou senha inválidos.');
    if (
      !user.isSuperAdmin &&
      !(await this.hasAuthenticationMembership(user.id))
    )
      throw this.noActiveCompany();
    if (!user.isActive)
      throw new UnauthorizedException('E-mail ou senha inválidos.');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_SECONDS * 1000);
    const refreshExpiresAt = new Date(now.getTime() + REFRESH_SECONDS * 1000);
    const refresh = newRefresh();
    const session = await this.prisma.$transaction(async (tx) => {
      // Recheck identity after the expensive password comparison; don't race a password reset/deactivation.
      const current = await tx.user.findFirst({
        where: { id: user.id, isActive: true, passwordHash: user.passwordHash },
        select: { id: true },
      });
      if (!current)
        throw new UnauthorizedException('E-mail ou senha inválidos.');
      if (
        !user.isSuperAdmin &&
        !(await this.hasAuthenticationMembership(user.id, tx))
      )
        throw this.noActiveCompany();
      return tx.authSession.create({
        data: {
          userId: user.id,
          credentialHash: credentialHash(user.passwordHash),
          expiresAt,
          refreshExpiresAt,
          refreshTokens: {
            create: {
              tokenHash: refreshHash(refresh),
              expiresAt: refreshExpiresAt,
            },
          },
        },
      });
    });
    return this.issue(user.id, session, refresh);
  }

  async trialSignup(input: unknown, ip: string) {
    const data = object(input, [
      'companyName', 'ownerName', 'whatsapp', 'email', 'password',
      'confirmPassword', 'planId', 'acceptTerms', 'marketingConsent', 'website', 'attribution',
    ]);
    const companyName = string(data.companyName, 'companyName', 120);
    const ownerName = string(data.ownerName, 'ownerName', 120);
    const rawEmail = string(data.email, 'email', 254).toLowerCase();
    const password = typeof data.password === 'string' && data.password.length <= 128 ? data.password : '';
    const confirmPassword = typeof data.confirmPassword === 'string' && data.confirmPassword.length <= 128 ? data.confirmPassword : '';
    const planId = uuid(data.planId);
    const rawPhone = string(data.whatsapp, 'whatsapp', 32);
    const attribution: Record<string, string> = {};
    if (data.attribution !== undefined) {
      if (!data.attribution || typeof data.attribution !== 'object' || Array.isArray(data.attribution))
        throw new ForbiddenException('PUBLIC_SIGNUP_REJECTED');
      const allowedAttribution = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'gbraid', 'wbraid', 'fbclid'];
      for (const [key, value] of Object.entries(data.attribution as Record<string, unknown>)) {
        if (!allowedAttribution.includes(key) || typeof value !== 'string' || value.length > 255 || /[\r\n]/.test(value))
          throw new ForbiddenException('PUBLIC_SIGNUP_REJECTED');
        attribution[key] = value;
      }
    }
    const phone = normalizeBrazilianPhone(rawPhone);
    boolean(data.acceptTerms, 'acceptTerms');
    boolean(data.marketingConsent, 'marketingConsent');
    if (typeof data.website !== 'string' || data.website.length > 200)
      throw new ForbiddenException('PUBLIC_SIGNUP_REJECTED');
    if (data.website.trim()) throw new ForbiddenException('PUBLIC_SIGNUP_REJECTED');
    if (!data.acceptTerms) throw new ForbiddenException('TERMS_ACCEPTANCE_REQUIRED');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail))
      throw new ForbiddenException('PUBLIC_SIGNUP_REJECTED');
    if (password !== confirmPassword || Buffer.byteLength(password) > 72 ||
      password.length < 12 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) ||
      !/\d/.test(password) || !/[^A-Za-z0-9]/.test(password))
      throw new ForbiddenException('PUBLIC_SIGNUP_REJECTED');
    if (!companyName.trim() || !ownerName.trim() || !phone)
      throw new ForbiddenException('PUBLIC_SIGNUP_REJECTED');

    await this.limiter.consume('public-trial-ip', ip, 5, 3600);
    await this.limiter.consume('public-trial-email', rawEmail, 3, 86400);
    const passwordHash = await bcrypt.hash(password, 12);
    const now = new Date();
    const randomSuffix = randomBytes(4).toString('hex');
    const baseSlug = companyName.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
    const slug = `${baseSlug || 'empresa'}-${randomSuffix}`;
    const refresh = newRefresh();
    const expiresAt = new Date(now.getTime() + SESSION_SECONDS * 1000);
    const refreshExpiresAt = new Date(now.getTime() + REFRESH_SECONDS * 1000);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const plan = await tx.plan.findFirst({
          where: { id: planId, isActive: true, isPublic: true, trialEnabled: true, trialDays: { gt: 0, lte: 365 } },
          select: { id: true, name: true, trialDays: true },
        });
        if (!plan) throw new ForbiddenException('PUBLIC_SIGNUP_REJECTED');
        const user = await tx.user.create({
          data: { name: ownerName, email: rawEmail, phone, passwordHash, isActive: true, isSuperAdmin: false },
          select: { id: true, name: true, email: true },
        });
        const company = await tx.company.create({
          data: { name: companyName.trim(), slug, status: 'TRIAL', administrativeStatus: 'ACTIVE', isActive: true, timezone: 'America/Sao_Paulo' },
          select: { id: true, name: true, slug: true },
        });
        await tx.membership.create({ data: { userId: user.id, companyId: company.id, role: 'OWNER', isActive: true } });
        const trialEndsAt = new Date(now);
        trialEndsAt.setUTCDate(trialEndsAt.getUTCDate() + plan.trialDays);
        const trialEndLabel = new Intl.DateTimeFormat('pt-BR', {
          dateStyle: 'long', timeZone: 'America/Sao_Paulo',
        }).format(trialEndsAt);
        const subscription = await tx.subscription.create({
          data: { companyId: company.id, planId: plan.id, status: 'TRIALING', billingInterval: 'MONTHLY', trialStartedAt: now, trialEndsAt, gateway: 'MANUAL' },
          select: { id: true, status: true, trialStartedAt: true, trialEndsAt: true },
        });
        await tx.publicSignupConsent.create({
          data: {
            userId: user.id, companyId: company.id,
            termsVersion: 'kalend-terms-2026-10-25', privacyVersion: 'kalend-privacy-2026-10-25',
            acceptedAt: now, marketingOptIn: data.marketingConsent === true,
            marketingConsentedAt: data.marketingConsent === true ? now : null,
            attribution: Object.keys(attribution).length ? attribution : undefined,
          },
        });
        await tx.globalCommunicationOutbox.create({
          data: {
            scope: 'GLOBAL', event: 'OWNER_WELCOME', businessKey: `owner-welcome:${company.id}`,
            companyId: company.id, userId: user.id,
            variables: { __channels: ['EMAIL'], plano: plan.name, vencimento: trialEndLabel },
          },
        });
        const session = await tx.authSession.create({
          data: {
            userId: user.id, selectedCompanyId: company.id, credentialHash: credentialHash(passwordHash),
            expiresAt, refreshExpiresAt,
            refreshTokens: { create: { tokenHash: refreshHash(refresh), expiresAt: refreshExpiresAt } },
          },
          select: { id: true, expiresAt: true, refreshExpiresAt: true },
        });
        return {
          user, company, subscription,
          tokens: {
            access: await this.tokens.access(user.id, session.id, new Date(Math.min(now.getTime() + ACCESS_SECONDS * 1000, expiresAt.getTime(), refreshExpiresAt.getTime()))),
            refresh, accessExpiresAt: new Date(Math.min(now.getTime() + ACCESS_SECONDS * 1000, expiresAt.getTime(), refreshExpiresAt.getTime())), refreshExpiresAt,
          },
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new ForbiddenException('PUBLIC_SIGNUP_REJECTED');
      throw error;
    }
  }
  private async issue(
    userId: string,
    session: { id: string; expiresAt: Date; refreshExpiresAt: Date },
    refresh: string,
  ) {
    const accessExpiresAt = new Date(
      Math.min(
        Date.now() + ACCESS_SECONDS * 1000,
        session.expiresAt.getTime(),
        session.refreshExpiresAt.getTime(),
      ),
    );
    return {
      access: await this.tokens.access(userId, session.id, accessExpiresAt),
      refresh,
      accessExpiresAt,
      refreshExpiresAt: session.refreshExpiresAt,
    };
  }
  async refresh(raw: unknown, ip: string) {
    await this.limiter.consume('refresh-ip', ip, 60, 60);
    if (!validRefresh(raw))
      throw new UnauthorizedException('Sessão inválida ou expirada.');
    const now = new Date();
    const refresh = newRefresh();
    const result = await this.prisma.$transaction(
      async (tx) => {
        const token = await tx.authRefreshToken.findUnique({
          where: { tokenHash: refreshHash(raw) },
          include: {
            session: {
              include: {
                user: {
                  select: {
                    id: true,
                    isActive: true,
                    isSuperAdmin: true,
                    passwordHash: true,
                  },
                },
              },
            },
          },
        });
        if (!token) return null;
        const s = token.session;
        if (
          !s.user.isSuperAdmin &&
          !(await this.hasAuthenticationMembership(s.user.id, tx))
        ) {
          await tx.authSession.updateMany({
            where: { userId: s.user.id, revokedAt: null },
            data: { revokedAt: now },
          });
          return { blocked: true as const };
        }
        if (
          token.usedAt ||
          s.revokedAt ||
          !s.user.isActive ||
          s.credentialHash !== credentialHash(s.user.passwordHash) ||
          s.expiresAt <= now ||
          s.refreshExpiresAt <= now ||
          token.expiresAt <= now
        ) {
          await tx.authSession.updateMany({
            where: { id: s.id, revokedAt: null },
            data: { revokedAt: now },
          });
          return null; // Commit revocation before returning 401; never throw inside this branch.
        }
        if (
          !s.user.isSuperAdmin &&
          !(await this.hasAuthenticationMembership(s.user.id, tx))
        ) {
          await tx.authSession.updateMany({
            where: { userId: s.user.id, revokedAt: null },
            data: { revokedAt: now },
          });
          return { blocked: true as const };
        }
        const claimed = await tx.authRefreshToken.updateMany({
          where: { id: token.id, usedAt: null },
          data: { usedAt: now },
        });
        if (claimed.count !== 1) {
          await tx.authSession.updateMany({
            where: { id: s.id, revokedAt: null },
            data: { revokedAt: now },
          });
          return null;
        }
        const refreshExpiresAt = new Date(
          Math.min(
            now.getTime() + REFRESH_SECONDS * 1000,
            s.expiresAt.getTime(),
          ),
        );
        const updated = await tx.authSession.updateMany({
          where: { id: s.id, revokedAt: null },
          data: { lastUsedAt: now, refreshExpiresAt },
        });
        if (updated.count !== 1) return null;
        await tx.authRefreshToken.create({
          data: {
            sessionId: s.id,
            tokenHash: refreshHash(refresh),
            expiresAt: refreshExpiresAt,
          },
        });
        return { blocked: false as const, session: { ...s, refreshExpiresAt } };
      },
      { isolationLevel: 'ReadCommitted' },
    );
    if (result?.blocked) throw this.noActiveCompany();
    if (!result)
      throw new UnauthorizedException('Sessão inválida ou expirada.');
    return this.issue(result.session.userId, result.session, refresh);
  }
  async authenticate(raw: string | undefined): Promise<AuthIdentity> {
    if (!raw) throw new UnauthorizedException('Autenticação necessária.');
    const claim = await this.tokens.verify(raw);
    const session = await this.prisma.authSession.findUnique({
      where: { id: claim.sessionId },
      include: { user: { select: { ...identitySelect, passwordHash: true } } },
    });
    const now = new Date();
    if (!session || session.userId !== claim.userId)
      throw new UnauthorizedException('Sessão inválida ou expirada.');
    if (
      !session.user.isSuperAdmin &&
      !(await this.hasAuthenticationMembership(session.user.id))
    ) {
      await this.prisma.authSession.updateMany({
        where: { userId: session.user.id, revokedAt: null },
        data: { revokedAt: now },
      });
      throw this.noActiveCompany();
    }
    if (
      session.revokedAt ||
      session.expiresAt <= now ||
      session.refreshExpiresAt <= now ||
      !session.user.isActive ||
      session.credentialHash !== credentialHash(session.user.passwordHash)
    )
      throw new UnauthorizedException('Sessão inválida ou expirada.');
    return {
      user: {
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
        isActive: session.user.isActive,
        isSuperAdmin: session.user.isSuperAdmin,
      },
      session: {
        id: session.id,
        selectedCompanyId: session.selectedCompanyId,
        expiresAt: session.expiresAt,
        refreshExpiresAt: session.refreshExpiresAt,
      },
    };
  }
  async logout(raw: unknown) {
    if (!validRefresh(raw)) return;
    const token = await this.prisma.authRefreshToken.findUnique({
      where: { tokenHash: refreshHash(raw) },
      select: { sessionId: true },
    });
    if (token)
      await this.prisma.authSession.updateMany({
        where: { id: token.sessionId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
  }
  async revokeCurrent(sessionId: string) {
    await this.prisma.authSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
  async logoutAll(userId: string) {
    await this.prisma.authSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
  async me(identity: AuthIdentity) {
    if (
      !identity.user.isSuperAdmin &&
      !(await this.hasAuthenticationMembership(identity.user.id))
    ) {
      await this.prisma.authSession.updateMany({
        where: { userId: identity.user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw this.noActiveCompany();
    }
    const memberships = await this.prisma.membership.findMany({
      where: { userId: identity.user.id, isActive: true },
      select: membershipSelect,
      orderBy: { createdAt: 'asc' },
    });
    const available = memberships.filter(
      (m) =>
        administrativelyActive(m.company) &&
        (m.role === 'OWNER' ||
          (['ACTIVE', 'TRIAL'].includes(m.company.status) &&
            m.company.isActive) ||
          ['SUSPENDED', 'CANCELED'].includes(m.company.status)),
    );
    const selected = available.find(
      (m) => m.companyId === identity.session.selectedCompanyId,
    );
    return {
      user: {
        id: identity.user.id,
        name: identity.user.name,
        email: identity.user.email,
        isSuperAdmin: identity.user.isSuperAdmin,
      },
      systemRole: identity.user.isSuperAdmin ? 'SUPER_ADMIN' : 'USER',
      memberships: available.map((m) => ({
        id: m.id,
        role: m.role,
        company: m.company,
      })),
      selectedCompanyId: selected?.companyId ?? null,
      session: {
        expiresAt: identity.session.expiresAt,
        refreshExpiresAt: identity.session.refreshExpiresAt,
      },
    };
  }
  async membership(userId: string, companyId: string, recovery = false) {
    const membership = await this.prisma.membership.findUnique({
      where: { userId_companyId: { userId, companyId } },
      select: membershipSelect,
    });
    if (!membership || !membership.isActive)
      throw new ForbiddenException({
        code: 'TENANT_ACCESS_REQUIRED',
        message: 'Acesso à empresa não permitido.',
      });
    assertAdministrativeAccess(membership.company);
    if (
      (!recovery &&
        (!membership.company.isActive ||
          !['ACTIVE', 'TRIAL'].includes(membership.company.status))) ||
      (recovery &&
        !membership.company.isActive &&
        !['SUSPENDED', 'CANCELED'].includes(membership.company.status) &&
        membership.role !== 'OWNER')
    )
      throw new ForbiddenException('Acesso à empresa não permitido.');
    if (!recovery) {
      const now = new Date();
      const current = await this.prisma.subscription.findFirst({
        where: entitledWhere(companyId, now),
      });
      if (!current) {
        const last = await this.prisma.subscription.findFirst({
          where: { companyId, status: { not: 'PENDING' } },
          orderBy: { createdAt: 'desc' },
        });
        throw new ForbiddenException({
          code: 'SUBSCRIPTION_REQUIRED',
          accessStatus: effectiveAccessStatus(current, last, now),
          regularizationRequired: true,
        });
      }
    }
    return membership;
  }
  async selectTenant(identity: AuthIdentity, input: unknown) {
    const { companyId } = parseSelectTenantDto(input);
    if (companyId) await this.membership(identity.user.id, companyId, true);
    const result = await this.prisma.authSession.updateMany({
      where: {
        id: identity.session.id,
        userId: identity.user.id,
        revokedAt: null,
        expiresAt: { gt: new Date() },
        refreshExpiresAt: { gt: new Date() },
      },
      data: { selectedCompanyId: companyId },
    });
    if (!result.count) throw new UnauthorizedException('Sessão inválida.');
    return this.me({
      ...identity,
      session: { ...identity.session, selectedCompanyId: companyId },
    });
  }
}
