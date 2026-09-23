import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class WebhooksService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    const events = await this.prisma.webhookEvent.findMany({
      orderBy: {
        receivedAt: 'desc',
      },
    });

    return events.map((event) => ({
      id: event.id,
      gateway: event.gateway,
      externalEventId: event.externalEventId,
      eventType: event.eventType,
      status: event.status,
      errorMessage: event.errorMessage,
      receivedAt: event.receivedAt,
      processedAt: event.processedAt,
      createdAt: event.createdAt,
      updatedAt: event.updatedAt,
    }));
  }

  async findOne(id: string) {
    return this.prisma.webhookEvent.findUnique({
      where: {
        id,
      },
    });
  }

  async summary() {
    const [
      total,
      received,
      processing,
      processed,
      failed,
      ignored,
    ] = await Promise.all([
      this.prisma.webhookEvent.count(),

      this.prisma.webhookEvent.count({
        where: {
          status: 'RECEIVED',
        },
      }),

      this.prisma.webhookEvent.count({
        where: {
          status: 'PROCESSING',
        },
      }),

      this.prisma.webhookEvent.count({
        where: {
          status: 'PROCESSED',
        },
      }),

      this.prisma.webhookEvent.count({
        where: {
          status: 'FAILED',
        },
      }),

      this.prisma.webhookEvent.count({
        where: {
          status: 'IGNORED',
        },
      }),
    ]);

    return {
      total,
      received,
      processing,
      processed,
      failed,
      ignored,
    };
  }
}
