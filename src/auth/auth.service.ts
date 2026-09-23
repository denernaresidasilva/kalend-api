import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
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
import type { AuthIdentity } from './auth.types.js';
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
    select: { id: true, name: true, slug: true, status: true, isActive: true },
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
    if (!user || !correct || !user.isActive)
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
    const session = await this.prisma.$transaction(
      async (tx) => {
        const token = await tx.authRefreshToken.findUnique({
          where: { tokenHash: refreshHash(raw) },
          include: {
            session: {
              include: {
                user: { select: { isActive: true, passwordHash: true } },
              },
            },
          },
        });
        if (!token) return null;
        const s = token.session;
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
        return { ...s, refreshExpiresAt };
      },
      { isolationLevel: 'ReadCommitted' },
    );
    if (!session)
      throw new UnauthorizedException('Sessão inválida ou expirada.');
    return this.issue(session.userId, session, refresh);
  }
  async authenticate(raw: string | undefined): Promise<AuthIdentity> {
    if (!raw) throw new UnauthorizedException('Autenticação necessária.');
    const claim = await this.tokens.verify(raw);
    const session = await this.prisma.authSession.findUnique({
      where: { id: claim.sessionId },
      include: { user: { select: { ...identitySelect, passwordHash: true } } },
    });
    const now = new Date();
    if (
      !session ||
      session.userId !== claim.userId ||
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
    const memberships = await this.prisma.membership.findMany({
      where: { userId: identity.user.id, isActive: true },
      select: membershipSelect,
      orderBy: { createdAt: 'asc' },
    });
    const available = memberships.filter(
      (m) =>
        m.company.isActive && ['ACTIVE', 'TRIAL'].includes(m.company.status),
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
  async membership(userId: string, companyId: string) {
    const membership = await this.prisma.membership.findUnique({
      where: { userId_companyId: { userId, companyId } },
      select: membershipSelect,
    });
    if (
      !membership ||
      !membership.isActive ||
      !membership.company.isActive ||
      !['ACTIVE', 'TRIAL'].includes(membership.company.status)
    )
      throw new ForbiddenException('Acesso à empresa não permitido.');
    return membership;
  }
  async selectTenant(identity: AuthIdentity, input: unknown) {
    const { companyId } = parseSelectTenantDto(input);
    if (companyId) await this.membership(identity.user.id, companyId);
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
