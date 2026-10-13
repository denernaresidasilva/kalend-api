import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CompanyStatus, MembershipRole, Prisma } from '@prisma/client';
import { adminList } from '../common/admin-list.js';
import { boolean, object, string, uuid } from '../common/validation.js';
import { PrismaService } from '../prisma/prisma.service.js';

const ROLES = new Set<string>(Object.values(MembershipRole));
const ACCESSIBLE_COMPANY_STATUSES = new Set([
  'ACTIVE',
  'TRIAL',
  'SUSPENDED',
  'CANCELED',
]);
const accessibleCompanyFilter: Prisma.CompanyWhereInput = {
  OR: [
    { isActive: true, status: { in: [CompanyStatus.ACTIVE, CompanyStatus.TRIAL] } },
    { status: { in: [CompanyStatus.SUSPENDED, CompanyStatus.CANCELED] } },
  ],
};
const accessibleMembershipFilter: Prisma.MembershipWhereInput = {
  isActive: true,
  company: { is: accessibleCompanyFilter },
};
const authenticationMembershipFilter: Prisma.MembershipWhereInput = {
  isActive: true,
  OR: [
    { role: MembershipRole.OWNER },
    { company: { is: accessibleCompanyFilter } },
  ],
};
type UserRow = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  isActive: boolean;
  isSuperAdmin: boolean;
  createdAt: Date;
  updatedAt: Date;
  memberships: Array<{
    id: string;
    role: MembershipRole;
    isActive: boolean;
    createdAt: Date;
    updatedAt?: Date;
    company: {
      id: string;
      name: string;
      slug: string;
      status: string;
      isActive: boolean;
      subscriptions?: Array<{
        id: string;
        status: string;
        plan: { id: string; name: string; code: string } | null;
      }>;
    };
  }>;
};
type MembershipInput = {
  companyId: string;
  role: MembershipRole;
  isActive: boolean;
};

function membershipHasCommercialAccess(membership: UserRow['memberships'][number]) {
  return membership.isActive && companyAllowsAccess(membership.company.status, membership.company.isActive);
}

function membershipAllowsAuthentication(membership: UserRow['memberships'][number]) {
  return membership.isActive && (
    membership.role === MembershipRole.OWNER ||
    companyAllowsAccess(membership.company.status, membership.company.isActive)
  );
}

function companyAllowsAccess(status: string, isActive: boolean) {
  return (
    ACCESSIBLE_COMPANY_STATUSES.has(status) &&
    ((isActive && (status === 'ACTIVE' || status === 'TRIAL')) ||
      status === 'SUSPENDED' ||
      status === 'CANCELED')
  );
}

function canAuthenticate(user: UserRow) {
  return (
    user.isActive &&
    (user.isSuperAdmin || user.memberships.some(membershipAllowsAuthentication))
  );
}

function parseMemberships(value: unknown): MembershipInput[] {
  if (!Array.isArray(value) || value.length > 100)
    throw new BadRequestException('Lista de empresas inválida.');
  const result = value.map((item) => {
    const data = object(item, ['companyId', 'role', 'isActive']);
    const companyId = uuid(data.companyId);
    const role = string(data.role, 'role', 32);
    boolean(data.isActive, 'isActive');
    if (!ROLES.has(role)) throw new BadRequestException('Função inválida.');
    return {
      companyId,
      role: role as MembershipRole,
      isActive: data.isActive !== false,
    };
  });
  if (new Set(result.map((item) => item.companyId)).size !== result.length)
    throw new BadRequestException('Empresa duplicada na lista.');
  return result;
}

function authenticationCompanyIds(user: UserRow) {
  return new Set(
    user.memberships
      .filter(membershipAllowsAuthentication)
      .map((membership) => membership.company.id),
  );
}

@Injectable()
export class UsersService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private serialize(user: UserRow) {
    const linkedCompanyIds = authenticationCompanyIds(user);
    const commerciallyAccessibleCompanyIds = new Set(
      user.memberships.filter(membershipHasCommercialAccess).map((membership) => membership.company.id),
    );
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      // This is the operational status shown to Super Admin, not just the DB flag.
      isActive: canAuthenticate(user),
      accountActive: user.isActive,
      canAuthenticate: canAuthenticate(user),
      canAccessTenant: user.isActive && (user.isSuperAdmin || user.memberships.some(membershipHasCommercialAccess)),
      isSuperAdmin: user.isSuperAdmin,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      memberships: user.memberships.map((membership) => ({
        id: membership.id,
        role: membership.role,
        isActive: membership.isActive,
        hasAccess: commerciallyAccessibleCompanyIds.has(membership.company.id),
        isLinked: linkedCompanyIds.has(membership.company.id),
        createdAt: membership.createdAt,
        updatedAt: membership.updatedAt,
        company: {
          id: membership.company.id,
          name: membership.company.name,
          slug: membership.company.slug,
          status: membership.company.status,
          isActive: membership.company.isActive,
        },
      })),
    };
  }

  async findAll(query: unknown = {}) {
    const page = adminList(query, ['q']);
    const users = await this.prisma.user.findMany({
      take: page.take,
      skip: page.skip,
      where: page.q
        ? {
            OR: ['name', 'email'].map((field) => ({
              [field]: { contains: page.q, mode: 'insensitive' as const },
            })),
          }
        : {},
      omit: { passwordHash: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: {
        memberships: {
          orderBy: { createdAt: 'asc' },
          include: { company: true },
        },
      },
    });
    return users.map((user) => this.serialize(user as UserRow));
  }

  async findOne(id: string) {
    const user = await this.prisma.user.findUnique({
      omit: { passwordHash: true },
      where: { id },
      include: {
        memberships: {
          orderBy: { createdAt: 'asc' },
          include: {
            company: {
              include: {
                subscriptions: {
                  orderBy: { createdAt: 'desc' },
                  take: 1,
                  include: { plan: true },
                },
              },
            },
          },
        },
      },
    });
    if (!user) return null;
    const serialized = this.serialize(user as UserRow);
    return {
      ...serialized,
      memberships: serialized.memberships.map((membership, index) => ({
        ...membership,
        company: {
          ...membership.company,
          subscription:
            (user as UserRow).memberships[index]?.company.subscriptions?.[0]
              ? {
                  id: (user as UserRow).memberships[index].company
                    .subscriptions![0].id,
                  status: (user as UserRow).memberships[index].company
                    .subscriptions![0].status,
                  plan: (user as UserRow).memberships[index].company
                    .subscriptions![0].plan,
                }
              : null,
        },
      })),
    };
  }

  async summary() {
    const [total, active, superAdmins, owners, professionals, clients] =
      await Promise.all([
        this.prisma.user.count(),
        this.prisma.user.count({
          where: {
            isActive: true,
            OR: [
              { isSuperAdmin: true },
              { memberships: { some: authenticationMembershipFilter } },
            ],
          },
        }),
        this.prisma.user.count({ where: { isSuperAdmin: true } }),
        this.prisma.membership.count({
          where: {
            isActive: true,
            role: 'OWNER',
            user: { isActive: true },
          },
        }),
        this.prisma.membership.count({
          where: {
            ...accessibleMembershipFilter,
            role: 'PROFESSIONAL',
            user: { isActive: true },
          },
        }),
        this.prisma.membership.count({
          where: {
            ...accessibleMembershipFilter,
            role: 'CLIENT',
            user: { isActive: true },
          },
        }),
      ]);
    return { total, active, inactive: total - active, superAdmins, owners, professionals, clients };
  }

  async update(id: string, input: unknown) {
    const data = object(input, ['name', 'phone', 'isActive', 'memberships']);
    if (!Object.keys(data).length)
      throw new BadRequestException('Informe ao menos um campo para atualizar.');
    const name = data.name === undefined ? undefined : string(data.name, 'name', 120);
    let phone: string | null | undefined;
    if (data.phone !== undefined) {
      if (data.phone !== null && typeof data.phone !== 'string')
        throw new BadRequestException('Telefone inválido.');
      phone = typeof data.phone === 'string' ? data.phone.trim() || null : null;
      if (phone && phone.length > 32)
        throw new BadRequestException('Telefone inválido.');
    }
    boolean(data.isActive, 'isActive');
    const requestedActive =
      typeof data.isActive === 'boolean' ? data.isActive : undefined;
    const desiredMemberships =
      data.memberships === undefined
        ? undefined
        : parseMemberships(data.memberships);
    const membershipsProvided = desiredMemberships !== undefined;

    await this.prisma.$transaction(
      async (tx) => {
        const current = await tx.user.findUnique({
          where: { id },
          select: { id: true, isActive: true, isSuperAdmin: true },
        });
        if (!current) throw new NotFoundException('Usuário não encontrado.');
        if (
          current.isSuperAdmin &&
          (membershipsProvided ||
            (requestedActive !== undefined &&
              requestedActive !== current.isActive))
        )
          throw new ForbiddenException('Não é permitido desativar ou alterar vínculos de Super Admin por esta tela.');

        let desiredCompanies = new Map<string, { status: string; isActive: boolean }>();
        if (desiredMemberships?.length) {
          const ids = desiredMemberships.map((membership) => membership.companyId);
          const companies = await tx.company.findMany({
            where: { id: { in: ids } },
            select: { id: true, status: true, isActive: true },
          });
          if (companies.length !== ids.length)
            throw new BadRequestException('Uma ou mais empresas não existem.');
          desiredCompanies = new Map(
            companies.map((company) => [company.id, { status: company.status, isActive: company.isActive }]),
          );
        }

        if (membershipsProvided) {
          await tx.membership.updateMany({
            where: { userId: id },
            data: { isActive: false },
          });
          for (const membership of desiredMemberships!) {
            await tx.membership.upsert({
              where: {
                userId_companyId: { userId: id, companyId: membership.companyId },
              },
              create: { ...membership, userId: id },
              update: { role: membership.role, isActive: membership.isActive },
            });
          }
        }

        const activeMemberships = membershipsProvided
          ? desiredMemberships!.filter((membership) => {
              const company = desiredCompanies.get(membership.companyId);
              return !!company && membership.isActive &&
                (membership.role === MembershipRole.OWNER || companyAllowsAccess(company.status, company.isActive));
            })
              .length
          : (await tx.membership.findMany({
              where: { userId: id, isActive: true },
              select: { isActive: true, role: true, company: { select: { status: true, isActive: true } } },
            })).filter((membership) => membership.isActive &&
              (membership.role === MembershipRole.OWNER || companyAllowsAccess(membership.company.status, membership.company.isActive))).length;
        const nextActive =
          requestedActive === undefined ? current.isActive : requestedActive;
        if (!current.isSuperAdmin && requestedActive === true && !activeMemberships)
          throw new BadRequestException('Vincule o usuário a uma empresa ativa antes de ativá-lo.');
        const shouldDeactivate = !current.isSuperAdmin && !activeMemberships;
        const isActive = shouldDeactivate ? false : nextActive;

        await tx.user.update({
          where: { id },
          data: {
            ...(name === undefined ? {} : { name }),
            ...(phone === undefined ? {} : { phone }),
            ...(isActive === current.isActive ? {} : { isActive }),
          },
        });
        if (!isActive || shouldDeactivate)
          await tx.authSession.updateMany({
            where: { userId: id, revokedAt: null },
            data: { revokedAt: new Date() },
          });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    const result = await this.findOne(id);
    if (!result) throw new NotFoundException('Usuário não encontrado.');
    return result;
  }

  async remove(id: string, input: unknown) {
    const data = object(input, ['confirmationEmail']);
    const confirmationEmail = string(data.confirmationEmail, 'confirmationEmail', 254);
    await this.prisma.$transaction(
      async (tx) => {
        const user = await tx.user.findUnique({
          where: { id },
          select: { id: true, email: true, isSuperAdmin: true },
        });
        if (!user) throw new NotFoundException('Usuário não encontrado.');
        if (user.isSuperAdmin)
          throw new ForbiddenException('Super Admin não pode ser excluído por esta tela.');
        if (confirmationEmail !== user.email)
          throw new BadRequestException('O e-mail de confirmação não corresponde.');
        const changed = await tx.user.updateMany({
          where: { id, isSuperAdmin: false },
          data: { isActive: false },
        });
        if (changed.count !== 1)
          throw new ConflictException('O usuário mudou durante a operação.');
        await tx.membership.updateMany({
          where: { userId: id, isActive: true },
          data: { isActive: false },
        });
        await tx.authSession.updateMany({
          where: { userId: id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    return { deactivated: true, userId: id };
  }
}
