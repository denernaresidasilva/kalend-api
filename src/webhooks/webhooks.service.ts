import { Inject } from '@nestjs/common';
import { safeEventSelect } from '../common/validation.js';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class WebhooksService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async findAll() {
    const events = await this.prisma.webhookEvent.findMany({
      select: safeEventSelect,
      take: 100,
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
      errorMessage: event.status === 'FAILED' ? 'PROCESSING_FAILED' : null,
      companyId: event.companyId,
      paymentId: event.paymentId,
      attempts: event.attempts,
      environment: event.environment,
      receivedAt: event.receivedAt,
      processedAt: event.processedAt,
      createdAt: event.createdAt,
      updatedAt: event.updatedAt,
    }));
  }

  async findOne(id: string) {
    const event = await this.prisma.webhookEvent.findUnique({
      select: safeEventSelect,
      where: {
        id,
      },
    });
    return event
      ? {
          ...event,
          errorMessage: event.status === 'FAILED' ? 'PROCESSING_FAILED' : null,
        }
      : null;
  }

  async summary() {
    const [total, received, processing, processed, failed, ignored] =
      await Promise.all([
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
