import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { boolean, object } from '../common/validation.js';
import { EVENTS, eventName, templateContent } from './contracts.js';
import type { Channel } from './contracts.js';
import { GlobalTemplateDefaults } from './template-defaults.js';

const CHANNELS = ['EMAIL', 'WHATSAPP', 'PUSH'] as const;

export function resolveEffectiveTemplate<
  G extends { enabled: boolean } | null | undefined,
  C extends { enabled: boolean } | null | undefined,
>(global: G, company: C) {
  if (company) return { ...company, source: 'COMPANY' as const };
  return global ? { ...global, source: 'GLOBAL' as const } : null;
}

@Injectable()
export class CompanyCommunicationTemplates {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(GlobalTemplateDefaults)
    private readonly defaults: GlobalTemplateDefaults,
  ) {}

  async list(companyId: string) {
    await this.defaults.ensure();
    const [globalRows, companyRows] = await Promise.all([
      this.db.globalCommunicationTemplate.findMany({
        where: { scope: 'GLOBAL' },
      }),
      this.db.companyCommunicationTemplate.findMany({
        where: { companyId },
      }),
    ]);
    const global = new Map(globalRows.map((row) => [`${row.event}:${row.channel}`, row]));
    const company = new Map(companyRows.map((row) => [`${row.event}:${row.channel}`, row]));
    return EVENTS.flatMap((event) => CHANNELS.map((channel) => {
      const key = `${event}:${channel}`;
      const override = company.get(key);
      const fallback = global.get(key);
      const effective = override ?? fallback;
      return {
        event,
        channel,
        enabled: effective?.enabled ?? false,
        content: effective?.content ?? {},
        source: override ? 'COMPANY' as const : 'GLOBAL' as const,
        hasOverride: !!override,
        revision: effective?.revision ?? 0,
      };
    }));
  }

  async save(companyId: string, eventValue: string, channelValue: string, input: unknown, actorId: string) {
    const event = eventName(eventValue);
    if (!EVENTS.includes(event as (typeof EVENTS)[number]))
      throw new BadRequestException('COMPANY_TEMPLATE_EVENT_INVALID');
    if (!CHANNELS.includes(channelValue as Channel))
      throw new BadRequestException('CHANNEL_INVALID');
    const channel = channelValue as Channel;
    const data = object(input, ['enabled', 'content']);
    boolean(data.enabled, 'enabled');
    if (typeof data.enabled !== 'boolean')
      throw new BadRequestException('TEMPLATE_ENABLED_REQUIRED');
    const content = templateContent(data.content, channel, event);
    await this.defaults.ensure();
    return this.db.$transaction(async (tx) => {
      const row = await tx.companyCommunicationTemplate.upsert({
        where: {
          companyId_event_channel: { companyId, event, channel },
        },
        create: { companyId, event, channel, enabled: data.enabled as boolean, content },
        update: { enabled: data.enabled as boolean, content, revision: { increment: 1 } },
      });
      await tx.globalCommunicationLog.create({
        data: {
          scope: 'COMPANY',
          actorId,
          action: `COMPANY_TEMPLATE_UPDATE_${event}_${channel}`,
          code: companyId,
        },
      });
      return { ...row, source: 'COMPANY' as const, hasOverride: true };
    });
  }

  async restore(companyId: string, eventValue: string, channelValue: string, actorId: string) {
    const event = eventName(eventValue);
    if (!EVENTS.includes(event as (typeof EVENTS)[number]))
      throw new BadRequestException('COMPANY_TEMPLATE_EVENT_INVALID');
    if (!CHANNELS.includes(channelValue as Channel))
      throw new BadRequestException('CHANNEL_INVALID');
    const channel = channelValue as Channel;
    await this.defaults.ensure();
    return this.db.$transaction(async (tx) => {
      const deleted = await tx.companyCommunicationTemplate.deleteMany({
        where: { companyId, event, channel },
      });
      if (!deleted.count)
        throw new NotFoundException('TEMPLATE_OVERRIDE_NOT_FOUND');
      await tx.globalCommunicationLog.create({
        data: {
          scope: 'COMPANY',
          actorId,
          action: `COMPANY_TEMPLATE_RESTORED_${event}_${channel}`,
          code: companyId,
        },
      });
      const global = await tx.globalCommunicationTemplate.findUnique({
        where: { event_channel: { event, channel } },
      });
      return {
        event,
        channel,
        enabled: global?.enabled ?? false,
        content: global?.content ?? {},
        source: 'GLOBAL' as const,
        hasOverride: false,
        revision: global?.revision ?? 0,
      };
    });
  }
}
