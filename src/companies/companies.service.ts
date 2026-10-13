import { randomUUID } from 'node:crypto';
import {
  EvolutionService,
  evolutionInstanceName,
} from '../communication/evolution.js';
import { adminList, listStatus } from '../common/admin-list.js';
import { Inject } from '@nestjs/common';
import { nextPeriod } from '../common/period.js';
import {
  object,
  string,
  uuid,
  boolean,
  safeUserSelect,
} from '../common/validation.js';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import * as bcrypt from 'bcrypt';

type CreateManualCompanyInput = {
  companyName: string;
  slug: string;
  timezone?: string;

  ownerName: string;
  ownerEmail: string;
  ownerPhone?: string;
  ownerPassword: string;

  planId: string;
  billingInterval?: 'MONTHLY' | 'YEARLY';

  startWithTrial?: boolean;
};

@Injectable()
export class CompaniesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(EvolutionService) private readonly evolution?: EvolutionService,
  ) {}

  async createManual(input: CreateManualCompanyInput) {
    object(input, [
      'companyName',
      'slug',
      'timezone',
      'ownerName',
      'ownerEmail',
      'ownerPhone',
      'ownerPassword',
      'planId',
      'billingInterval',
      'startWithTrial',
    ]);
    for (const key of [
      'companyName',
      'slug',
      'ownerName',
      'ownerEmail',
      'ownerPassword',
    ] as const)
      string(input[key], key);
    for (const key of ['timezone', 'ownerPhone'] as const)
      if (input[key] !== undefined) string(input[key], key);
    uuid(input.planId);
    boolean(input.startWithTrial, 'startWithTrial');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.ownerEmail.trim()))
      throw new BadRequestException('E-mail inválido.');
    if (Buffer.byteLength(input.ownerPassword) > 72)
      throw new BadRequestException('Senha excede 72 bytes.');
    try {
      new Intl.DateTimeFormat('en', {
        timeZone: input.timezone ?? 'America/Sao_Paulo',
      });
    } catch {
      throw new BadRequestException('Timezone inválido.');
    }
    const companyName = input.companyName?.trim();
    const slug = input.slug
      ?.trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    const ownerName = input.ownerName?.trim();
    const ownerEmail = input.ownerEmail?.trim().toLowerCase();

    const ownerPhone = input.ownerPhone?.trim() || null;

    const timezone = input.timezone?.trim() || 'America/Sao_Paulo';

    const billingInterval = input.billingInterval ?? 'MONTHLY';

    const startWithTrial = input.startWithTrial ?? true;

    if (!companyName) {
      throw new BadRequestException('Informe o nome da empresa.');
    }

    if (!slug) {
      throw new BadRequestException('Informe um subdomínio válido.');
    }

    if (!ownerName) {
      throw new BadRequestException('Informe o nome do proprietário.');
    }

    if (!ownerEmail) {
      throw new BadRequestException('Informe o e-mail do proprietário.');
    }

    if (!input.ownerPassword || input.ownerPassword.length < 8) {
      throw new BadRequestException(
        'A senha deve possuir pelo menos 8 caracteres.',
      );
    }

    if (!input.planId) {
      throw new BadRequestException('Selecione um plano.');
    }

    if (billingInterval !== 'MONTHLY' && billingInterval !== 'YEARLY') {
      throw new BadRequestException('Periodicidade de cobrança inválida.');
    }

    const plan = await this.prisma.plan.findUnique({
      where: {
        id: input.planId,
      },
    });

    if (!plan) {
      throw new NotFoundException('Plano não encontrado.');
    }

    if (!plan.isActive) {
      throw new BadRequestException('O plano selecionado está inativo.');
    }

    if (billingInterval === 'YEARLY' && plan.yearlyPriceCents === null) {
      throw new BadRequestException(
        'Este plano não possui cobrança anual configurada.',
      );
    }

    if (startWithTrial && (!plan.trialEnabled || plan.trialDays < 1)) {
      throw new BadRequestException(
        'O plano selecionado não possui teste grátis habilitado.',
      );
    }

    const existingCompany = await this.prisma.company.findUnique({
      where: {
        slug,
      },
    });

    if (existingCompany) {
      throw new ConflictException('Este subdomínio já está sendo utilizado.');
    }

    const existingUser = await this.prisma.user.findUnique({
      where: {
        email: ownerEmail,
      },
    });

    if (existingUser && (!existingUser.isActive || existingUser.isSuperAdmin))
      throw new ConflictException('Proprietário indisponível.');
    const passwordHash = existingUser
      ? ''
      : await bcrypt.hash(input.ownerPassword, 12);

    const now = new Date();

    let trialEndsAt: Date | null = null;
    let currentPeriodStart: Date | null = null;
    let currentPeriodEnd: Date | null = null;

    if (startWithTrial) {
      trialEndsAt = new Date(now);

      trialEndsAt.setUTCDate(trialEndsAt.getUTCDate() + plan.trialDays);
    } else {
      currentPeriodStart = new Date(now);

      currentPeriodEnd = nextPeriod(now, billingInterval);
    }

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.upsert({
          where: { email: ownerEmail },
          update: {},
          create: {
            name: ownerName,
            email: ownerEmail,
            phone: ownerPhone,
            passwordHash,
            isActive: true,
            isSuperAdmin: false,
          },
        });

        if (!user.isActive || user.isSuperAdmin)
          throw new ConflictException('Proprietário indisponível.');
        const companyId = randomUUID();
        const company = await tx.company.create({
          data: {
            id: companyId,
            evolutionConnection: {
              create: {
                instanceName: evolutionInstanceName(companyId),
                provisionRequested: true,
                provisionRetryAt: new Date(),
              },
            },
            name: companyName,
            slug,
            timezone,
            status: startWithTrial ? 'TRIAL' : 'ACTIVE',
            isActive: true,
          },
        });

        const membership = await tx.membership.create({
          data: {
            userId: user.id,
            companyId: company.id,
            role: 'OWNER',
            isActive: true,
          },
        });

        const subscription = await tx.subscription.create({
          data: {
            companyId: company.id,
            planId: plan.id,

            status: startWithTrial ? 'TRIALING' : 'ACTIVE',

            billingInterval,

            trialStartedAt: startWithTrial ? now : null,

            trialEndsAt,

            currentPeriodStart,
            currentPeriodEnd,

            gateway: 'MANUAL',
          },

          include: {
            plan: true,
          },
        });

        return {
          company,
          owner: {
            id: user.id,
            name: user.name,
            email: user.email,
            phone: user.phone,
          },
          membership: {
            id: membership.id,
            role: membership.role,
          },
          subscription: {
            id: subscription.id,
            status: subscription.status,
            billingInterval: subscription.billingInterval,
            trialStartedAt: subscription.trialStartedAt,
            trialEndsAt: subscription.trialEndsAt,
            currentPeriodStart: subscription.currentPeriodStart,
            currentPeriodEnd: subscription.currentPeriodEnd,
            gateway: subscription.gateway,

            plan: {
              id: subscription.plan.id,
              name: subscription.plan.name,
              code: subscription.plan.code,
            },
          },
        };
      });

      // The durable PENDING record was committed with the company. Network work is independent.
      void this.evolution?.prepareAfterCompanyCreated(result.company.id);
      return result;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'Já existe um cadastro utilizando estes dados.',
        );
      }

      throw error;
    }
  }

  async findAll(query: unknown = {}) {
    const page = adminList(query);
    const companies = await this.prisma.company.findMany({
      take: page.take,
      skip: page.skip,
      where: {
        status: listStatus(page.status, [
          'TRIAL',
          'ACTIVE',
          'SUSPENDED',
          'CANCELED',
        ]),
        ...(page.q
          ? {
              OR: ['name', 'slug'].map((field) => ({
                [field]: { contains: page.q, mode: 'insensitive' as const },
              })),
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],

      include: {
        memberships: {
          include: {
            user: { select: safeUserSelect },
          },
        },

        subscriptions: {
          orderBy: {
            createdAt: 'desc',
          },
          take: 1,

          include: {
            plan: {
              include: {
                features: true,
              },
            },
          },
        },

        _count: {
          select: {
            memberships: true,
          },
        },
      },
    });

    return companies.map((company) => {
      const subscription = company.subscriptions[0] ?? null;

      const ownerMembership =
        company.memberships.find(
          (membership) => String(membership.role).toUpperCase() === 'OWNER',
        ) ??
        company.memberships[0] ??
        null;

      return {
        id: company.id,
        name: company.name,
        slug: company.slug,
        timezone: company.timezone,
        status: company.status,
        createdAt: company.createdAt,
        updatedAt: company.updatedAt,

        owner: ownerMembership
          ? {
              id: ownerMembership.user.id,
              name: ownerMembership.user.name,
              email: ownerMembership.user.email,
            }
          : null,

        usersCount: company._count.memberships,

        subscription: subscription
          ? {
              id: subscription.id,
              status: subscription.status,
              trialEndsAt: subscription.trialEndsAt,
              currentPeriodStart: subscription.currentPeriodStart,
              currentPeriodEnd: subscription.currentPeriodEnd,

              plan: subscription.plan
                ? {
                    id: subscription.plan.id,
                    name: subscription.plan.name,
                    code: subscription.plan.code,
                  }
                : null,
            }
          : null,
      };
    });
  }

  async findOne(id: string) {
    return this.prisma.company.findUnique({
      where: {
        id,
      },

      include: {
        memberships: {
          include: {
            user: { select: safeUserSelect },
          },
        },

        subscriptions: {
          orderBy: {
            createdAt: 'desc',
          },

          include: {
            plan: {
              include: {
                features: true,
              },
            },

            payments: {
              orderBy: {
                createdAt: 'desc',
              },
            },
          },
        },
      },
    });
  }

  async update(id: string, input: unknown) {
    const data = object(input, [
      'name',
      'slug',
      'timezone',
      'status',
      'ownerEmail',
      'planId',
    ]);
    if (Object.keys(data).length === 0)
      throw new BadRequestException('Informe ao menos um campo para atualizar.');

    const update: {
      name?: string;
      slug?: string;
      timezone?: string;
      status?: 'TRIAL' | 'ACTIVE' | 'SUSPENDED' | 'CANCELED';
      isActive?: boolean;
    } = {};
    if (data.name !== undefined) {
      update.name = string(data.name, 'name', 120);
    }
    if (data.slug !== undefined) {
      const slug = string(data.slug, 'slug', 100)
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
      if (!slug || slug.length > 63)
        throw new BadRequestException('Subdomínio inválido.');
      update.slug = slug;
    }
    if (data.timezone !== undefined) {
      const timezone = string(data.timezone, 'timezone', 80);
      try {
        new Intl.DateTimeFormat('en', { timeZone: timezone });
      } catch {
        throw new BadRequestException('Timezone inválido.');
      }
      update.timezone = timezone;
    }
    if (data.status !== undefined) {
      if (
        typeof data.status !== 'string' ||
        !['TRIAL', 'ACTIVE', 'SUSPENDED', 'CANCELED'].includes(data.status)
      )
        throw new BadRequestException('Status de empresa inválido.');
      update.status = data.status as NonNullable<typeof update.status>;
      update.isActive = data.status === 'ACTIVE' || data.status === 'TRIAL';
    }
    let ownerEmail: string | undefined;
    if (data.ownerEmail !== undefined) {
      ownerEmail = string(data.ownerEmail, 'ownerEmail', 254).toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail))
        throw new BadRequestException('E-mail do responsável inválido.');
    }
    const planId = data.planId === undefined ? undefined : uuid(data.planId);

    try {
      await this.prisma.$transaction(async (tx) => {
        const company = await tx.company.findUnique({
          where: { id },
          select: { id: true },
        });
        if (!company) throw new NotFoundException('Empresa não encontrada.');

        if (ownerEmail) {
          const owner = await tx.user.findUnique({
            where: { email: ownerEmail },
            select: { id: true, isActive: true, isSuperAdmin: true },
          });
          if (!owner || !owner.isActive || owner.isSuperAdmin)
            throw new BadRequestException(
              'O responsável deve ser um usuário ativo existente que não seja Super Admin.',
            );
          await tx.membership.updateMany({
            where: { companyId: id, role: 'OWNER', userId: { not: owner.id } },
            data: { role: 'ADMIN' },
          });
          await tx.membership.upsert({
            where: { userId_companyId: { userId: owner.id, companyId: id } },
            create: {
              userId: owner.id,
              companyId: id,
              role: 'OWNER',
              isActive: true,
            },
            update: { role: 'OWNER', isActive: true },
          });
        }

        if (planId) {
          const plan = await tx.plan.findUnique({
            where: { id: planId },
            select: { id: true, isActive: true },
          });
          if (!plan || !plan.isActive)
            throw new BadRequestException('Selecione um plano ativo.');
          const subscription = await tx.subscription.findFirst({
            where: { companyId: id },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            select: { id: true, status: true },
          });
          if (!subscription)
            throw new ConflictException(
              'A empresa não possui assinatura para atualizar o plano.',
            );
          if (subscription.status !== 'TRIALING')
            throw new ConflictException(
              'Altere o plano de assinaturas fora de teste pela gestão de assinaturas.',
            );
          await tx.subscription.update({
            where: { id: subscription.id },
            data: { planId },
          });
        }

        if (Object.keys(update).length)
          await tx.company.update({ where: { id }, data: update });
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        throw new ConflictException(
          'Já existe uma empresa utilizando este subdomínio.',
        );
      throw error;
    }

    return this.findOne(id);
  }

  async remove(id: string, input: unknown) {
    const data = object(input, ['confirmationName']);
    const confirmationName = data.confirmationName;
    if (typeof confirmationName !== 'string')
      throw new BadRequestException('Confirme o nome da empresa para excluir.');

    const company = await this.prisma.company.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        evolutionConnection: {
          select: {
            companyId: true,
            globalKey: true,
            provisionRequested: true,
            prepared: true,
            status: true,
          },
        },
      },
    });
    if (!company) throw new NotFoundException('Empresa não encontrada.');
    if (confirmationName !== company.name)
      throw new BadRequestException(
        'O nome informado não corresponde ao nome da empresa.',
      );

    const connection = company.evolutionConnection;
    if (connection) {
      if (connection.companyId !== id || connection.globalKey !== null)
        throw new ConflictException(
          'A conexão Evolution não corresponde a esta empresa.',
        );
      if (
        connection.prepared ||
        connection.provisionRequested ||
        connection.status !== 'PENDING'
      ) {
        if (!this.evolution)
          throw new ServiceUnavailableException(
            'Não foi possível concluir a remoção segura da conexão da empresa.',
          );
        // External deletion is idempotent. A failure leaves the Company intact;
        // if the database transaction later fails, retrying safely repeats it.
        const removed = await this.evolution.remove(id);
        const cleanedConnection = await this.prisma.evolutionConnection.findUnique({
          where: { companyId: id },
          select: {
            companyId: true,
            globalKey: true,
            prepared: true,
            status: true,
          },
        });
        if (
          removed.status !== 'PENDING' ||
          !cleanedConnection ||
          cleanedConnection.companyId !== id ||
          cleanedConnection.globalKey !== null ||
          cleanedConnection.prepared ||
          cleanedConnection.status !== 'PENDING'
        )
          throw new ServiceUnavailableException(
            'Não foi possível confirmar a remoção segura da conexão da empresa.',
          );
      }
    }

    await this.prisma.$transaction(async (tx) => {
      // Keep the affected identities before the company cascade removes memberships.
      const companyMemberships = await tx.membership.findMany({
        where: { companyId: id },
        select: { userId: true },
      });
      const outbox = await tx.globalCommunicationOutbox.findMany({
        where: { companyId: id },
        select: { id: true },
      });
      const outboxIds = outbox.map((row) => row.id);
      if (outboxIds.length) {
        const deliveries = await tx.globalCommunicationDelivery.findMany({
          where: { outboxId: { in: outboxIds } },
          select: { id: true },
        });
        const deliveryIds = deliveries.map((row) => row.id);
        await tx.globalCommunicationLog.deleteMany({
          where: {
            OR: [
              { outboxId: { in: outboxIds } },
              ...(deliveryIds.length
                ? [{ deliveryId: { in: deliveryIds } }]
                : []),
            ],
          },
        });
        if (deliveryIds.length)
          await tx.globalCommunicationDelivery.deleteMany({
            where: { id: { in: deliveryIds } },
          });
        await tx.globalCommunicationOutbox.deleteMany({
          where: { id: { in: outboxIds }, companyId: id },
        });
      }
      await tx.webhookEvent.deleteMany({ where: { companyId: id } });
      await tx.company.delete({ where: { id } });

      const affectedUserIds = [...new Set(companyMemberships.map((m) => m.userId))];
      if (affectedUserIds.length) {
        // A user is disabled only when the deleted tenant was their last active
        // membership. Shared users and Super Admin accounts remain untouched.
        const orphanedUsers = await tx.user.findMany({
          where: {
            id: { in: affectedUserIds },
            isSuperAdmin: false,
            memberships: { none: { isActive: true } },
          },
          select: { id: true },
        });
        const orphanedUserIds = orphanedUsers.map((user) => user.id);
        if (orphanedUserIds.length) {
          const revokedAt = new Date();
          await tx.user.updateMany({
            where: {
              id: { in: orphanedUserIds },
              isSuperAdmin: false,
              memberships: { none: { isActive: true } },
            },
            data: { isActive: false },
          });
          await tx.authSession.updateMany({
            where: { userId: { in: orphanedUserIds }, revokedAt: null },
            data: { revokedAt },
          });
        }
      }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    return { deleted: true, companyId: id };
  }
}
