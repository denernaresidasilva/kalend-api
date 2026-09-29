import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { object, string } from '../common/validation.js';
import { TransportFailure } from './contracts.js';
import type { Message, Transport, Variables } from './contracts.js';
import { jsonRequest } from './network.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SecretVault } from '../billing/secret-vault.js';
// No inferred latest version. Operator pins the reviewed Graph version for this installation.
export function metaUrl(c: Variables, resource: string) {
  if (
    !/^v\d+\.0$/.test(c.graphVersion) ||
    c.graphVersion !== process.env.COMMUNICATION_META_GRAPH_VERSION ||
    !/^[0-9]+(?:\/(?:messages|message_templates))?$/.test(resource)
  )
    throw new TransportFailure('PERMANENT');
  return new URL(`https://graph.facebook.com/${c.graphVersion}/${resource}`);
}
export function metaName(value: unknown) {
  const s = string(value, 'name', 512);
  if (!/^[a-z0-9_]+$/.test(s))
    throw new BadRequestException('META_NAME_INVALID');
  return s;
}
export function language(value: unknown) {
  const s = string(value, 'language', 20);
  if (!/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(s))
    throw new BadRequestException('META_LANGUAGE_INVALID');
  return s;
}
export type MetaTemplate = {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  components: Record<string, unknown>[];
};
export function metaTemplate(value: unknown): MetaTemplate {
  if (!value || typeof value !== 'object')
    throw new TransportFailure('PERMANENT');
  const r = value as Record<string, unknown>;
  if (
    typeof r.id !== 'string' ||
    !/^\d+$/.test(r.id) ||
    typeof r.status !== 'string' ||
    !/^[A-Z_]{1,64}$/.test(r.status) ||
    typeof r.category !== 'string' ||
    !/^[A-Z_]{1,64}$/.test(r.category) ||
    !Array.isArray(r.components)
  )
    throw new TransportFailure('PERMANENT');
  return {
    id: r.id,
    name: metaName(r.name),
    language: language(r.language),
    status: r.status,
    category: r.category,
    components: r.components.map((component) => {
      if (
        !component ||
        typeof component !== 'object' ||
        typeof component.type !== 'string' ||
        component.type.length > 64
      )
        throw new TransportFailure('PERMANENT');
      const result: Record<string, unknown> = { type: component.type };
      if (typeof component.text === 'string' && component.text.length <= 16000)
        result.text = component.text;
      if (typeof component.format === 'string' && component.format.length <= 64)
        result.format = component.format;
      return result;
    }),
  };
}
export async function metaPage(
  c: Variables,
  s: Variables,
  name?: string,
  after?: string,
) {
  const url = metaUrl(c, `${c.businessAccountId}/message_templates`);
  url.searchParams.set('fields', 'id,name,language,category,status,components');
  url.searchParams.set('limit', '100');
  if (name) url.searchParams.set('name', metaName(name));
  if (after) {
    if (after.length > 2048 || !/^[a-zA-Z0-9_=+-]+$/.test(after))
      throw new BadRequestException('CURSOR_INVALID');
    url.searchParams.set('after', after);
  }
  const r = await jsonRequest(url, {
    Authorization: `Bearer ${s.accessToken}`,
  });
  if (!Array.isArray(r.data)) throw new TransportFailure('PERMANENT');
  const paging = r.paging as
    { next?: unknown; cursors?: { after?: unknown } } | undefined;
  const next = paging?.next ? paging.cursors?.after : null;
  if (next !== null && typeof next !== 'string')
    throw new TransportFailure('PERMANENT');
  return { data: r.data.map(metaTemplate), after: next as string | null };
}
export class MetaTransport implements Transport {
  async verify(c: Variables, s: Variables) {
    await metaPage(c, s);
  }
  async send(c: Variables, s: Variables, m: Message) {
    if (!m.meta) throw new TransportFailure('TEMPLATE');
    const page = await metaPage(c, s, m.meta.name);
    const t = page.data.find(
      (t) =>
        t.id === m.meta!.id &&
        t.name === m.meta!.name &&
        t.language === m.meta!.language,
    );
    if (!t || t.status !== 'APPROVED') throw new TransportFailure('TEMPLATE');
    // Deliberately supports BODY-only text templates; never drops required header/buttons.
    if (
      t.components.length !== 1 ||
      t.components[0].type !== 'BODY' ||
      typeof t.components[0].text !== 'string'
    )
      throw new TransportFailure('TEMPLATE');
    const text = t.components[0].text;
    const placeholders = [...text.matchAll(/\{\{(\d+)\}\}/g)].map((match) =>
      Number(match[1]),
    );
    const count = new Set(placeholders).size;
    if (
      count !== m.meta.parameters.length ||
      placeholders.some((n) => n < 1 || n > count) ||
      /[{}]/.test(text.replace(/\{\{\d+\}\}/g, ''))
    )
      throw new TransportFailure('TEMPLATE');
    const template = {
      name: t.name,
      language: { code: t.language },
      ...(count
        ? {
            components: [
              {
                type: 'body',
                parameters: m.meta.parameters.map((text) => ({
                  type: 'text',
                  text,
                })),
              },
            ],
          }
        : {}),
    };
    const r = await jsonRequest(
      metaUrl(c, `${c.phoneNumberId}/messages`),
      { Authorization: `Bearer ${s.accessToken}` },
      {
        messaging_product: 'whatsapp',
        to: m.to.slice(1),
        type: 'template',
        template,
      },
    );
    const id = (r.messages as { id?: unknown }[] | undefined)?.[0]?.id;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9._=+/-]{1,512}$/.test(id))
      throw new TransportFailure('UNCERTAIN');
    return id;
  }
}
@Injectable()
export class MetaTemplates {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(SecretVault) private readonly vault: SecretVault,
  ) {}
  async context() {
    const row = await this.db.globalCommunicationProvider.findUnique({
      where: { provider: 'META' },
    });
    if (!row?.credentialsEncrypted)
      throw new ServiceUnavailableException('META_NOT_CONFIGURED');
    return {
      row,
      c: row.config as Variables,
      s: JSON.parse(
        this.vault.decrypt(
          row.credentialsEncrypted,
          `communication:GLOBAL:META:${row.environment}:credentials`,
        ),
      ) as Variables,
    };
  }
  async sync(input: unknown, actorId: string) {
    const d = object(input, ['after']);
    const ctx = await this.context();
    const page = await metaPage(
      ctx.c,
      ctx.s,
      undefined,
      d.after === undefined ? undefined : string(d.after, 'after', 2048),
    );
    await this.db.$transaction(async (tx) => {
      for (const t of page.data) {
        const data = {
          environment: ctx.row.environment,
          businessAccountId: ctx.c.businessAccountId,
          externalId: t.id,
          name: t.name,
          language: t.language,
          category: t.category,
          status: t.status,
          components: JSON.parse(JSON.stringify(t.components)) as object[],
          syncedAt: new Date(),
        };
        await tx.globalCommunicationMetaTemplate.upsert({
          where: {
            environment_businessAccountId_externalId: {
              environment: data.environment,
              businessAccountId: data.businessAccountId,
              externalId: data.externalId,
            },
          },
          create: data,
          update: data,
        });
      }
      await tx.globalCommunicationLog.create({
        data: { actorId, action: 'META_TEMPLATE_SYNC' },
      });
    });
    return { synced: page.data.length, after: page.after };
  }
  async create(input: unknown, actorId: string) {
    const d = object(input, ['name', 'language', 'category', 'text']);
    const name = metaName(d.name),
      lang = language(d.language),
      text = string(d.text, 'text', 1024);
    // Static utility BODY is the proven minimal submission contract. No local APPROVED assignment.
    if (d.category !== 'UTILITY' || /[{}]/.test(text))
      throw new BadRequestException('META_STATIC_UTILITY_BODY_REQUIRED');
    const ctx = await this.context();
    await this.db.globalCommunicationLog.create({
      data: { actorId, action: 'META_TEMPLATE_SUBMIT_STARTED' },
    });
    try {
      const r = await jsonRequest(
        metaUrl(ctx.c, `${ctx.c.businessAccountId}/message_templates`),
        { Authorization: `Bearer ${ctx.s.accessToken}` },
        {
          name,
          language: lang,
          category: 'UTILITY',
          components: [{ type: 'BODY', text }],
        },
      );
      const id = typeof r.id === 'string' && /^\d+$/.test(r.id) ? r.id : null;
      if (!id) throw new TransportFailure('UNCERTAIN');
      await this.db.globalCommunicationLog.create({
        data: { actorId, action: 'META_TEMPLATE_SUBMITTED' },
      });
      return { externalId: id, syncRequired: true };
    } catch {
      throw new ServiceUnavailableException(
        'META_SUBMISSION_FAILED_OR_UNCERTAIN_SYNC_BEFORE_RETRY',
      );
    }
  }
  async list() {
    const ctx = await this.context();
    return this.db.globalCommunicationMetaTemplate.findMany({
      where: {
        environment: ctx.row.environment,
        businessAccountId: ctx.c.businessAccountId,
      },
      take: 100,
      orderBy: { name: 'asc' },
    });
  }
}
