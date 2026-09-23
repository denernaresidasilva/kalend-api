import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
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
  constructor(private readonly prisma: PrismaService) {}

  async createManual(input: CreateManualCompanyInput) {
    const companyName = input.companyName?.trim();
    const slug = input.slug
      ?.trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    const ownerName = input.ownerName?.trim();
    const ownerEmail = input.ownerEmail
      ?.trim()
      .toLowerCase();

    const ownerPhone =
      input.ownerPhone?.trim() || null;

    const timezone =
      input.timezone?.trim() ||
      'America/Sao_Paulo';

    const billingInterval =
      input.billingInterval ?? 'MONTHLY';

    const startWithTrial =
      input.startWithTrial ?? true;

    if (!companyName) {
      throw new BadRequestException(
        'Informe o nome da empresa.',
      );
    }

    if (!slug) {
      throw new BadRequestException(
        'Informe um subdomínio válido.',
      );
    }

    if (!ownerName) {
      throw new BadRequestException(
        'Informe o nome do proprietário.',
      );
    }

    if (!ownerEmail) {
      throw new BadRequestException(
        'Informe o e-mail do proprietário.',
      );
    }

    if (
      !input.ownerPassword ||
      input.ownerPassword.length < 8
    ) {
      throw new BadRequestException(
        'A senha deve possuir pelo menos 8 caracteres.',
      );
    }

    if (!input.planId) {
      throw new BadRequestException(
        'Selecione um plano.',
      );
    }

    if (
      billingInterval !== 'MONTHLY' &&
      billingInterval !== 'YEARLY'
    ) {
      throw new BadRequestException(
        'Periodicidade de cobrança inválida.',
      );
    }

    const plan = await this.prisma.plan.findUnique({
      where: {
        id: input.planId,
      },
    });

    if (!plan) {
      throw new NotFoundException(
        'Plano não encontrado.',
      );
    }

    if (!plan.isActive) {
      throw new BadRequestException(
        'O plano selecionado está inativo.',
      );
    }

    if (
      billingInterval === 'YEARLY' &&
      plan.yearlyPriceCents === null
    ) {
      throw new BadRequestException(
        'Este plano não possui cobrança anual configurada.',
      );
    }

    if (
      startWithTrial &&
      !plan.trialEnabled
    ) {
      throw new BadRequestException(
        'O plano selecionado não possui teste grátis habilitado.',
      );
    }

    const existingCompany =
      await this.prisma.company.findUnique({
        where: {
          slug,
        },
      });

    if (existingCompany) {
      throw new ConflictException(
        'Este subdomínio já está sendo utilizado.',
      );
    }

    const existingUser =
      await this.prisma.user.findUnique({
        where: {
          email: ownerEmail,
        },
      });

    if (existingUser) {
      throw new ConflictException(
        'Já existe um usuário cadastrado com este e-mail.',
      );
    }

    const passwordHash = await bcrypt.hash(
      input.ownerPassword,
      12,
    );

    const now = new Date();

    let trialEndsAt: Date | null = null;
    let currentPeriodStart: Date | null = null;
    let currentPeriodEnd: Date | null = null;

    if (startWithTrial) {
      trialEndsAt = new Date(now);

      trialEndsAt.setDate(
        trialEndsAt.getDate() + plan.trialDays,
      );
    } else {
      currentPeriodStart = new Date(now);

      currentPeriodEnd = new Date(now);

      if (billingInterval === 'YEARLY') {
        currentPeriodEnd.setFullYear(
          currentPeriodEnd.getFullYear() + 1,
        );
      } else {
        currentPeriodEnd.setMonth(
          currentPeriodEnd.getMonth() + 1,
        );
      }
    }

    try {
      const result = await this.prisma.$transaction(
        async (tx) => {
          const user = await tx.user.create({
            data: {
              name: ownerName,
              email: ownerEmail,
              phone: ownerPhone,
              passwordHash,
              isActive: true,
              isSuperAdmin: false,
            },
          });

          const company = await tx.company.create({
            data: {
              name: companyName,
              slug,
              timezone,
              status: startWithTrial
                ? 'TRIAL'
                : 'ACTIVE',
              isActive: true,
            },
          });

          const membership =
            await tx.membership.create({
              data: {
                userId: user.id,
                companyId: company.id,
                role: 'OWNER',
                isActive: true,
              },
            });

          const subscription =
            await tx.subscription.create({
              data: {
                companyId: company.id,
                planId: plan.id,

                status: startWithTrial
                  ? 'TRIALING'
                  : 'ACTIVE',

                billingInterval,

                trialStartedAt: startWithTrial
                  ? now
                  : null,

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
              billingInterval:
                subscription.billingInterval,
              trialStartedAt:
                subscription.trialStartedAt,
              trialEndsAt:
                subscription.trialEndsAt,
              currentPeriodStart:
                subscription.currentPeriodStart,
              currentPeriodEnd:
                subscription.currentPeriodEnd,
              gateway: subscription.gateway,

              plan: {
                id: subscription.plan.id,
                name: subscription.plan.name,
                code: subscription.plan.code,
              },
            },
          };
        },
      );

      return result;
    } catch (error) {
      if (
        error instanceof
          Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'Já existe um cadastro utilizando estes dados.',
        );
      }

      throw error;
    }
  }

  async findAll() {
    const companies =
      await this.prisma.company.findMany({
        orderBy: {
          createdAt: 'desc',
        },

        include: {
          memberships: {
            include: {
              user: true,
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
      const subscription =
        company.subscriptions[0] ?? null;

      const ownerMembership =
        company.memberships.find(
          (membership) =>
            String(
              membership.role,
            ).toUpperCase() === 'OWNER',
        ) ??
        company.memberships[0] ??
        null;

      return {
        id: company.id,
        name: company.name,
        slug: company.slug,
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
              trialEndsAt:
                subscription.trialEndsAt,
              currentPeriodStart:
                subscription.currentPeriodStart,
              currentPeriodEnd:
                subscription.currentPeriodEnd,

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
            user: true,
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
}
