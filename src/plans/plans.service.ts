import { Inject } from '@nestjs/common';
import { validatePlan } from './plan.validation.js';
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

interface PlanFeatureInput {
  code: string;
  name: string;
  enabled?: boolean;
}

interface CreatePlanInput {
  name: string;
  code: string;
  description?: string;

  monthlyPriceCents: number;
  yearlyPriceCents?: number;

  trialEnabled?: boolean;
  trialDays?: number;

  badge?: string;
  isFeatured?: boolean;
  displayOrder?: number;

  maxProfessionals?: number;
  maxClients?: number;
  maxUnits?: number;

  isActive?: boolean;

  features?: PlanFeatureInput[];
}

interface UpdatePlanInput extends Partial<CreatePlanInput> {}

@Injectable()
export class PlansService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async findAll() {
    return this.prisma.plan.findMany({
      include: {
        features: {
          orderBy: {
            createdAt: 'asc',
          },
        },
      },
      orderBy: [
        {
          displayOrder: 'asc',
        },
        {
          monthlyPriceCents: 'asc',
        },
      ],
    });
  }

  async findPublic() {
    return this.prisma.plan.findMany({
      where: {
        isActive: true,
      },
      include: {
        features: {
          where: {
            enabled: true,
          },
          orderBy: {
            createdAt: 'asc',
          },
        },
      },
      orderBy: [
        {
          displayOrder: 'asc',
        },
        {
          monthlyPriceCents: 'asc',
        },
      ],
    });
  }

  async findOne(id: string) {
    const plan = await this.prisma.plan.findUnique({
      where: {
        id,
      },
      include: {
        features: true,
      },
    });

    if (!plan) {
      throw new NotFoundException('Plano não encontrado');
    }

    return plan;
  }

  async create(data: CreatePlanInput) {
    validatePlan(data);
    return this.prisma.plan.create({
      data: {
        name: data.name,
        code: data.code.trim().toLowerCase(),
        description: data.description,

        monthlyPriceCents: data.monthlyPriceCents,
        yearlyPriceCents: data.yearlyPriceCents,

        trialEnabled: data.trialEnabled ?? true,
        trialDays: data.trialDays ?? 7,

        badge: data.badge,
        isFeatured: data.isFeatured ?? false,
        displayOrder: data.displayOrder ?? 0,

        maxProfessionals: data.maxProfessionals,
        maxClients: data.maxClients,
        maxUnits: data.maxUnits ?? 1,

        isActive: data.isActive ?? true,

        features: data.features?.length
          ? {
              create: data.features.map((feature) => ({
                code: feature.code.trim().toLowerCase(),
                name: feature.name,
                enabled: feature.enabled ?? true,
              })),
            }
          : undefined,
      },
      include: {
        features: true,
      },
    });
  }

  async update(id: string, data: UpdatePlanInput) {
    validatePlan(data, true);
    await this.findOne(id);

    return this.prisma.$transaction(async (tx) => {
      if (data.features !== undefined) {
        await tx.planFeature.deleteMany({
          where: {
            planId: id,
          },
        });
      }

      return tx.plan.update({
        where: {
          id,
        },
        data: {
          name: data.name,
          code:
            data.code !== undefined
              ? data.code.trim().toLowerCase()
              : undefined,
          description: data.description,

          monthlyPriceCents: data.monthlyPriceCents,
          yearlyPriceCents: data.yearlyPriceCents,

          trialEnabled: data.trialEnabled,
          trialDays: data.trialDays,

          badge: data.badge,
          isFeatured: data.isFeatured,
          displayOrder: data.displayOrder,

          maxProfessionals: data.maxProfessionals,
          maxClients: data.maxClients,
          maxUnits: data.maxUnits,

          isActive: data.isActive,

          features:
            data.features !== undefined
              ? {
                  create: data.features.map((feature) => ({
                    code: feature.code.trim().toLowerCase(),
                    name: feature.name,
                    enabled: feature.enabled ?? true,
                  })),
                }
              : undefined,
        },
        include: {
          features: true,
        },
      });
    });
  }

  async deactivate(id: string) {
    await this.findOne(id);

    return this.prisma.plan.update({
      where: {
        id,
      },
      data: {
        isActive: false,
      },
    });
  }
}
