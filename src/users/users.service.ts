import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    const users = await this.prisma.user.findMany({
      orderBy: {
        createdAt: 'desc',
      },

      include: {
        memberships: {
          orderBy: {
            createdAt: 'asc',
          },

          include: {
            company: true,
          },
        },
      },
    });

    return users.map((user) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      isActive: user.isActive,
      isSuperAdmin: user.isSuperAdmin,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,

      memberships: user.memberships.map(
        (membership) => ({
          id: membership.id,
          role: membership.role,
          isActive: membership.isActive,
          createdAt: membership.createdAt,

          company: {
            id: membership.company.id,
            name: membership.company.name,
            slug: membership.company.slug,
            status: membership.company.status,
            isActive: membership.company.isActive,
          },
        }),
      ),
    }));
  }

  async findOne(id: string) {
    const user = await this.prisma.user.findUnique({
      where: {
        id,
      },

      include: {
        memberships: {
          include: {
            company: {
              include: {
                subscriptions: {
                  orderBy: {
                    createdAt: 'desc',
                  },

                  take: 1,

                  include: {
                    plan: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!user) {
      return null;
    }

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      isActive: user.isActive,
      isSuperAdmin: user.isSuperAdmin,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,

      memberships: user.memberships.map(
        (membership) => ({
          id: membership.id,
          role: membership.role,
          isActive: membership.isActive,
          createdAt: membership.createdAt,
          updatedAt: membership.updatedAt,

          company: {
            id: membership.company.id,
            name: membership.company.name,
            slug: membership.company.slug,
            status: membership.company.status,
            isActive: membership.company.isActive,

            subscription:
              membership.company.subscriptions[0]
                ? {
                    id: membership.company.subscriptions[0].id,
                    status:
                      membership.company.subscriptions[0]
                        .status,

                    plan: membership.company
                      .subscriptions[0].plan
                      ? {
                          id: membership.company
                            .subscriptions[0].plan.id,

                          name: membership.company
                            .subscriptions[0].plan.name,

                          code: membership.company
                            .subscriptions[0].plan.code,
                        }
                      : null,
                  }
                : null,
          },
        }),
      ),
    };
  }

  async summary() {
    const [
      total,
      active,
      inactive,
      superAdmins,
      owners,
      professionals,
      clients,
    ] = await Promise.all([
      this.prisma.user.count(),

      this.prisma.user.count({
        where: {
          isActive: true,
        },
      }),

      this.prisma.user.count({
        where: {
          isActive: false,
        },
      }),

      this.prisma.user.count({
        where: {
          isSuperAdmin: true,
        },
      }),

      this.prisma.membership.count({
        where: {
          role: 'OWNER',
          isActive: true,
        },
      }),

      this.prisma.membership.count({
        where: {
          role: 'PROFESSIONAL',
          isActive: true,
        },
      }),

      this.prisma.membership.count({
        where: {
          role: 'CLIENT',
          isActive: true,
        },
      }),
    ]);

    return {
      total,
      active,
      inactive,
      superAdmins,
      owners,
      professionals,
      clients,
    };
  }
}

