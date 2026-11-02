import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service.js';
import { EntitlementsService } from '../billing/entitlements.service.js';
import { withBillingConflictRetry } from '../billing/transaction-conflict.js';
import { object, string } from '../common/validation.js';
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const invalid = () => new BadRequestException('Não foi possível ativar o acesso. Confira o convite, o e-mail e a senha.');

@Injectable()
export class CustomerAccessService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
  ) {}
  async issue(companyId: string, customerId: string, actorId: string) {
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 3600000);
    return withBillingConflictRetry(() => this.db.$transaction(async tx => {
      const customer = await tx.customerProfile.findFirst({ where: { id: customerId, companyId } });
      if (!customer) throw new NotFoundException('Cliente não encontrado.');
      if (!customer.email) throw new BadRequestException('O cliente precisa informar um e-mail para ativar o acesso.');
      if (customer.userId) throw new ConflictException('O cliente já possui acesso ativado.');
      await tx.customerActivation.upsert({
        where: { customerId_companyId: { customerId, companyId } },
        create: { customerId, companyId, createdById: actorId, tokenHash: hash(token), expiresAt },
        update: { createdById: actorId, tokenHash: hash(token), expiresAt, usedAt: null, createdAt: new Date() },
      });
      return { token, expiresAt };
    }, { isolationLevel: 'Serializable' }));
  }

  async activate(input: unknown) {
    const body = object(input, ['token', 'email', 'password', 'termsAccepted']);
    if (body.termsAccepted !== true) throw new BadRequestException('Aceite os termos e a política de privacidade.');
    const token = string(body.token, 'token', 64);
    if (!/^[0-9a-f]{64}$/.test(token)) throw invalid();
    const email = string(body.email, 'email', 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || typeof body.password !== 'string' || body.password.length < 8 || Buffer.byteLength(body.password) > 72) throw invalid();
    const tokenHash = hash(token);
    // Validate the capability before expensive bcrypt work; no account lookup by arbitrary email.
    const invitation = await this.db.customerActivation.findUnique({ where: { tokenHash }, include: { customer: true } });
    if (!invitation || invitation.usedAt || invitation.expiresAt <= new Date() || invitation.customer.userId || invitation.customer.email !== email) throw invalid();
    const existing = await this.db.user.findUnique({ where: { email } });
    if (existing && (!existing.isActive || existing.isSuperAdmin || !await bcrypt.compare(body.password, existing.passwordHash))) throw invalid();
    const passwordHash = existing?.passwordHash ?? await bcrypt.hash(body.password, 12);
    return withBillingConflictRetry(() => this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "CustomerActivation" WHERE "tokenHash" = ${tokenHash} FOR UPDATE`;
      const current = await tx.customerActivation.findUnique({ where: { tokenHash }, include: { customer: true } });
      if (!current || current.usedAt || current.expiresAt <= new Date() || current.customer.userId || current.customer.email !== email) throw invalid();
      const company = await tx.company.findUniqueOrThrow({ where: { id: current.companyId } });
      if (!company.isActive || !['ACTIVE', 'TRIAL'].includes(company.status)) throw invalid();
      await this.entitlements.current(current.companyId, tx);
      let user = await tx.user.findUnique({ where: { email } });
      // A concurrent signup/password change never lets an invitation overwrite another identity.
      if (existing) {
        if (!user || user.id !== existing.id || user.passwordHash !== existing.passwordHash || !user.isActive || user.isSuperAdmin) throw invalid();
      } else {
        if (user) throw invalid();
        user = await tx.user.create({ data: { email, name: current.customer.name, passwordHash, isSuperAdmin: false } });
      }
      const membership = await tx.membership.findUnique({ where: { userId_companyId: { userId: user!.id, companyId: current.companyId } } });
      if (membership && !membership.isActive) throw invalid();
      if (!membership) await tx.membership.create({ data: { userId: user!.id, companyId: current.companyId, role: 'CLIENT' } });
      await tx.customerProfile.update({ where: { id: current.customerId }, data: { userId: user!.id } });
      await tx.customerActivation.update({ where: { id: current.id }, data: { usedAt: new Date() } });
      await tx.publicSignupConsent.upsert({ where: { userId_companyId: { userId: user!.id, companyId: current.companyId } }, create: { userId: user!.id, companyId: current.companyId, termsVersion: '2026-11-02', privacyVersion: '2026-11-02', source: 'CUSTOMER_ACTIVATION' }, update: {} });
      return { activated: true };
    }, { isolationLevel: 'Serializable', maxWait: 5000, timeout: 10000 }));
  }

  async customers(companyId: string) {
    return this.db.customerProfile.findMany({ where: { companyId }, select: { id: true, name: true, email: true, phone: true, userId: true }, orderBy: { createdAt: 'desc' }, take: 100 });
  }
  async mine(companyId: string, userId: string) {
    const company = await this.db.company.findUniqueOrThrow({ where: { id: companyId }, select: { timezone: true } });
    const requests = await this.db.bookingRequest.findMany({ where: { companyId, customer: { userId } }, select: { id: true, status: true, createdAt: true, items: { select: { id: true, serviceName: true, priceCents: true, startsAt: true, endsAt: true, professional: { select: { displayName: true } } }, orderBy: { startsAt: 'asc' } } }, orderBy: { createdAt: 'desc' }, take: 100 });
    return { timezone: company.timezone, requests };
  }
}
