import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { EntitlementsService } from '../billing/entitlements.service.js';
import {
  OperationsService,
  type Operator,
} from '../operations/operations.service.js';
import { wallClock } from '../bookings/booking-domain.js';
import { BookingsService } from '../bookings/bookings.service.js';
import { integer, object, string, uuid } from '../common/validation.js';
import {
  AI_POLICY,
  AI_PROVIDER,
  AI_TOOLS,
  boundedAiDecision,
  type AiProvider,
  type AiToolName,
} from './provider.js';
@Injectable()
export class AssistantService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(OperationsService) private readonly ops: OperationsService,
    @Inject(EntitlementsService)
    private readonly entitlements: EntitlementsService,
    @Inject(BookingsService) private readonly bookings: BookingsService,
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
  ) {}
  async settings(actor: Operator, input?: unknown) {
    if (input === undefined) {
      const sub = await this.entitlements.current(actor.companyId);
      return {
        settings: await this.db.aiAssistantSettings.findUnique({
          where: { companyId: actor.companyId },
        }),
        provider: {
          id: this.provider.id,
          configured: this.provider.available(),
          status: this.provider.available()
            ? 'CONFIGURED_UNVERIFIED'
            : 'DEPENDENCIA_EXTERNA',
        },
        entitled: sub.plan.features.some(
          (f) => f.code === 'ai_assistant' && f.enabled,
        ),
        remoteHomologated: false,
      };
    }
    const b = object(input, [
      'enabled',
      'name',
      'welcome',
      'tone',
      'businessInfo',
      'schedule',
      'humanHandoff',
      'maxMessagesPerDay',
      'maxInputTokens',
      'maxOutputTokens',
      'maxEstimatedCostCents',
      'historyEnabled',
      'retentionDays',
    ]);
    for (const k of ['enabled', 'humanHandoff', 'historyEnabled'])
      if (typeof b[k] !== 'boolean')
        throw new BadRequestException('Preferência inválida.');
    if (!['NEUTRAL', 'FRIENDLY', 'FORMAL'].includes(String(b.tone)))
      throw new BadRequestException('Tom inválido.');
    const name = string(b.name, 'name', 80),
      welcome = string(b.welcome, 'welcome', 1000),
      businessInfo =
        b.businessInfo === ''
          ? ''
          : string(b.businessInfo, 'businessInfo', 3000);
    integer(b.maxMessagesPerDay, 'maxMessagesPerDay', 1, 10000);
    integer(b.maxInputTokens, 'maxInputTokens', 100, 8000);
    integer(b.maxOutputTokens, 'maxOutputTokens', 50, 1000);
    integer(b.maxEstimatedCostCents, 'maxEstimatedCostCents', 1, 1000000);
    integer(b.retentionDays, 'retentionDays', 1, 90);
    if (!Array.isArray(b.schedule) || b.schedule.length > 14)
      throw new BadRequestException('Horário inválido.');
    const schedule = b.schedule.map((raw) => {
      const w = object(raw, ['weekday', 'startMinute', 'endMinute']);
      integer(w.weekday, 'weekday', 0, 6);
      integer(w.startMinute, 'startMinute', 0, 1439);
      integer(w.endMinute, 'endMinute', 1, 1440);
      if (Number(w.startMinute) >= Number(w.endMinute))
        throw new BadRequestException('Horário inválido.');
      return {
        weekday: w.weekday as number,
        startMinute: w.startMinute as number,
        endMinute: w.endMinute as number,
      };
    });
    return this.ops.change(actor, ['OWNER', 'ADMIN'], async (tx) => {
      await this.entitlements.assertFeature(
        actor.companyId,
        'ai_assistant',
        tx,
      );
      if (b.enabled && !this.provider.available())
        throw new ServiceUnavailableException('AI_PROVIDER_NOT_CONFIGURED');
      const data = {
        enabled: b.enabled as boolean,
        name,
        welcome,
        tone: b.tone as string,
        businessInfo,
        schedule,
        humanHandoff: b.humanHandoff as boolean,
        maxMessagesPerDay: b.maxMessagesPerDay as number,
        maxInputTokens: b.maxInputTokens as number,
        maxOutputTokens: b.maxOutputTokens as number,
        maxEstimatedCostCents: b.maxEstimatedCostCents as number,
        historyEnabled: b.historyEnabled as boolean,
        retentionDays: b.retentionDays as number,
      };
      const row = await tx.aiAssistantSettings.upsert({
        where: { companyId: actor.companyId },
        create: { companyId: actor.companyId, ...data },
        update: data,
      });
      await tx.posAudit.create({
        data: {
          companyId: actor.companyId,
          actorId: actor.userId,
          action: 'AI_SETTINGS_SAVED',
          detail: {
            enabled: row.enabled,
            provider: this.provider.id,
            historyEnabled: row.historyEnabled,
          },
        },
      });
      return row;
    });
  }
  async dashboard(actor: Operator) {
    const rows = await this.db.aiToolAudit.groupBy({
      by: ['provider', 'status', 'tool'],
      where: { companyId: actor.companyId },
      _count: true,
      _sum: {
        inputTokens: true,
        outputTokens: true,
        estimatedCostCents: true,
        reservedCents: true,
      },
    });
    return {
      provider: this.provider.id,
      remoteStatus: 'DEPENDENCIA_EXTERNA',
      conversationsStarted: null,
      conversationsTransferred: null,
      bookingsConfirmed: null,
      requestsGenerated: null,
      usage: rows,
      notice:
        'Ferramentas são verificadas localmente; conversas WhatsApp e atribuição aguardam integração remota. Custos ausentes não representam custo zero.',
    };
  }
  private validateTool(input: unknown) {
    const b = object(input, ['tool', 'arguments']);
    if (!AI_TOOLS.includes(b.tool as AiToolName))
      throw new BadRequestException('Ferramenta não permitida.');
    return { tool: b.tool as AiToolName, args: b.arguments ?? {} };
  }
  async tools(actor: Operator, input: unknown, probe = true) {
    const { tool, args } = this.validateTool(input);
    return this.ops.change(actor, ['OWNER', 'ADMIN', 'CLIENT'], async (tx) => {
      await this.entitlements.assertFeature(
        actor.companyId,
        'ai_assistant',
        tx,
      );
      const company = await tx.company.findUniqueOrThrow({
        where: { id: actor.companyId },
        select: { slug: true, name: true, timezone: true },
      });
      let result: unknown;
      if (tool === 'catalog') {
        object(args, []);
        result = await this.bookings.catalog(company.slug);
      } else if (tool === 'availability') {
        const b = object(args, ['serviceId', 'professionalId', 'date']);
        result = await this.bookings.availability(
          company.slug,
          uuid(b.serviceId),
          b.date,
          b.professionalId ? uuid(b.professionalId) : undefined,
        );
      } else if (tool === 'business_info') {
        object(args, []);
        const settings = await tx.aiAssistantSettings.findUnique({
          where: { companyId: actor.companyId },
        });
        result = {
          name: company.name,
          timezone: company.timezone,
          information: settings?.businessInfo ?? '',
          schedule: settings?.schedule ?? [],
          source: 'ESTABLISHMENT_CONFIGURATION',
        };
      } else if (tool === 'prepare_request') {
        const b = object(args, [
            'serviceId',
            'professionalId',
            'date',
            'startsAt',
          ]),
          serviceId = uuid(b.serviceId),
          professionalId = uuid(b.professionalId),
          startsAt = string(b.startsAt, 'startsAt', 40);
        const available = await this.bookings.availability(
          company.slug,
          serviceId,
          b.date,
          professionalId,
        );
        if (
          !available.professionals.some(
            (p) => p.id === professionalId && p.slots.includes(startsAt),
          )
        )
          throw new ConflictException('Horário não disponível.');
        const catalog = await this.bookings.catalog(company.slug),
          service = catalog.services.find((s) => s.id === serviceId);
        if (!service) throw new NotFoundException();
        result = {
          serviceId,
          professionalId,
          startsAt,
          serviceName: service.name,
          priceCents: service.priceCents,
          durationMinutes: service.durationMinutes,
          status: 'DRAFT_REQUIRES_CUSTOMER_SUBMISSION',
          bookingUrl:
            '/agendar/' +
            encodeURIComponent(company.slug) +
            '?' +
            new URLSearchParams({ serviceId, professionalId, startsAt }),
          financialConfirmation: false,
        };
      } else if (tool === 'own_requests') {
        object(args, []);
        if (actor.role !== 'CLIENT')
          throw new ForbiddenException(
            'Autenticação própria de cliente obrigatória.',
          );
        const customer = await tx.customerProfile.findFirst({
          where: { companyId: actor.companyId, userId: actor.userId },
        });
        if (!customer) throw new ForbiddenException();
        result = {
          requests: await tx.bookingRequest.findMany({
            where: { companyId: actor.companyId, customerId: customer.id },
            select: {
              id: true,
              status: true,
              items: {
                select: {
                  serviceName: true,
                  startsAt: true,
                  professional: { select: { displayName: true } },
                },
              },
            },
            orderBy: { createdAt: 'desc' },
            take: 10,
          }),
        };
      } else {
        object(args, []);
        result = {
          status: 'HUMAN_REQUIRED',
          message: 'Entre em contato com a equipe do estabelecimento.',
          bookingUrl: '/agendar/' + encodeURIComponent(company.slug),
        };
      }
      if (probe)
        await tx.aiToolAudit.create({
          data: {
            companyId: actor.companyId,
            actorId: actor.userId,
            tool,
            status: 'OK',
            provider: 'TOOL_PROBE',
          },
        });
      return result;
    });
  }
  async interpret(actor: Operator, input: unknown) {
    const b = object(input, ['idempotencyKey', 'message']),
      key = uuid(b.idempotencyKey),
      message = string(b.message, 'message', 2000);
    if (!this.provider.available())
      throw new ServiceUnavailableException('AI_PROVIDER_NOT_CONFIGURED');
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ actorId: actor.userId, message }))
      .digest('hex');
    const reserved = await this.ops.change(
      actor,
      ['OWNER', 'ADMIN', 'CLIENT'],
      async (tx) => {
        await this.entitlements.assertFeature(
          actor.companyId,
          'ai_assistant',
          tx,
        );
        const settings = await tx.aiAssistantSettings.findUnique({
          where: { companyId: actor.companyId },
        });
        if (!settings?.enabled)
          throw new ForbiddenException('Assistente desativado.');
        const company = await tx.company.findUniqueOrThrow({
          where: { id: actor.companyId },
          select: { timezone: true },
        });
        const clock = wallClock(new Date(), company.timezone),
          windows = settings.schedule as Array<{
            weekday: number;
            startMinute: number;
            endMinute: number;
          }>;
        if (
          windows.length &&
          !windows.some(
            (w) =>
              w.weekday === clock.weekday &&
              clock.minute >= w.startMinute &&
              clock.minute < w.endMinute,
          )
        )
          throw new ServiceUnavailableException('AI_OUTSIDE_BUSINESS_HOURS');
        const old = await tx.aiToolAudit.findUnique({
          where: {
            companyId_requestKey: {
              companyId: actor.companyId,
              requestKey: key,
            },
          },
        });
        if (old) {
          if (old.requestHash !== requestHash)
            throw new ConflictException('Chave já utilizada.');
          return { row: old, settings, existing: true };
        }
        const upper = this.provider.upperBoundCostCents();
        if (upper === null || !Number.isSafeInteger(upper) || upper < 0)
          throw new ServiceUnavailableException('AI_COST_BOUND_REQUIRED');
        const from = new Date(Date.now() - 86400000),
          month = new Date();
        month.setUTCDate(1);
        month.setUTCHours(0, 0, 0, 0);
        const daily = await tx.aiToolAudit.count({
          where: {
            companyId: actor.companyId,
            provider: { not: 'TOOL_PROBE' },
            createdAt: { gte: from },
          },
        });
        if (daily >= settings.maxMessagesPerDay)
          throw new ForbiddenException('AI_MESSAGE_LIMIT');
        const aggregate = await tx.aiToolAudit.aggregate({
          where: {
            companyId: actor.companyId,
            provider: { not: 'TOOL_PROBE' },
            createdAt: { gte: month },
          },
          _sum: { reservedCents: true },
        });
        if (
          (aggregate._sum.reservedCents ?? 0) + upper >
          settings.maxEstimatedCostCents
        )
          throw new ForbiddenException('AI_COST_LIMIT');
        const count = await tx.aiToolAudit.count({
          where: {
            companyId: actor.companyId,
            provider: { not: 'TOOL_PROBE' },
            createdAt: { gte: month },
          },
        });
        const sends = await tx.globalCommunicationDelivery.count({
          where: {
            outbox: { companyId: actor.companyId },
            createdAt: { gte: month },
          },
        });
        await this.entitlements.assertLimit(
          tx,
          actor.companyId,
          'messages',
          count + sends,
        );
        const row = await tx.aiToolAudit.create({
          data: {
            companyId: actor.companyId,
            actorId: actor.userId,
            tool: 'CLASSIFY',
            status: 'RESERVED',
            provider: this.provider.id,
            requestKey: key,
            requestHash,
            reservedCents: upper,
          },
        });
        return { row, settings, existing: false };
      },
    );
    if (reserved.existing) {
      if (reserved.row.status !== 'OK' || !reserved.row.decision)
        throw new ConflictException(
          'Processamento pendente ou incerto; não repetido para evitar custo duplicado.',
        );
      return this.tools(actor, reserved.row.decision, false);
    }
    try {
      const decision = await boundedAiDecision(this.provider, {
        instructions: AI_POLICY,
        untrustedMessage: message,
        maxInputTokens: reserved.settings.maxInputTokens,
        maxOutputTokens: reserved.settings.maxOutputTokens,
        timeoutMs: 12000,
        allowedTools: AI_TOOLS,
      });
      this.validateTool({ tool: decision.tool, arguments: decision.arguments });
      integer(
        decision.usage.inputTokens,
        'inputTokens',
        0,
        reserved.settings.maxInputTokens,
      );
      integer(
        decision.usage.outputTokens,
        'outputTokens',
        0,
        reserved.settings.maxOutputTokens,
      );
      if (decision.usage.estimatedCostCents !== null)
        integer(
          decision.usage.estimatedCostCents,
          'estimatedCostCents',
          0,
          reserved.row.reservedCents,
        );
      const safe = {
        tool: decision.tool,
        arguments: decision.arguments,
      } as Prisma.InputJsonObject;
      const result = await this.tools(actor, safe, false);
      await this.db.aiToolAudit.update({
        where: { id: reserved.row.id },
        data: {
          status: 'OK',
          tool: decision.tool,
          inputTokens: decision.usage.inputTokens,
          outputTokens: decision.usage.outputTokens,
          estimatedCostCents: decision.usage.estimatedCostCents,
          decision: safe,
        },
      });
      return result;
    } catch {
      await this.db.aiToolAudit.update({
        where: { id: reserved.row.id },
        data: { status: 'FAILED' },
      });
      throw new ServiceUnavailableException(
        'AI_PROVIDER_FAILED_HANDOFF_REQUIRED',
      );
    }
  }
}
