import {
  BadRequestException,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Injectable,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { MetaTemplates } from './meta.js';
function same(a: string, b: string) {
  return timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest(),
  );
}
export function verifyMetaSignature(
  raw: Buffer | undefined,
  signature: unknown,
  secret: string | undefined,
) {
  if (
    !raw ||
    raw.length > 262144 ||
    typeof signature !== 'string' ||
    !/^sha256=[a-f0-9]{64}$/.test(signature) ||
    !secret
  )
    throw new UnauthorizedException('META_SIGNATURE_INVALID');
  const expected = createHmac('sha256', secret).update(raw).digest('hex');
  if (!same(signature.slice(7), expected))
    throw new UnauthorizedException('META_SIGNATURE_INVALID');
}
@Injectable()
export class MetaWebhook {
  constructor(
    @Inject(MetaTemplates) private readonly meta: MetaTemplates,
    @Inject(PrismaService) private readonly db: PrismaService,
  ) {}
  async challenge(query: Record<string, unknown>) {
    const { s } = await this.meta.context();
    if (
      query['hub.mode'] !== 'subscribe' ||
      typeof query['hub.verify_token'] !== 'string' ||
      !s.verifyToken ||
      !same(query['hub.verify_token'], s.verifyToken) ||
      typeof query['hub.challenge'] !== 'string' ||
      !/^\d{1,100}$/.test(query['hub.challenge'])
    )
      throw new UnauthorizedException('META_VERIFICATION_INVALID');
    return query['hub.challenge'];
  }
  async receive(raw: Buffer | undefined, signature: unknown) {
    const { row, c, s } = await this.meta.context();
    verifyMetaSignature(raw, signature, s.appSecret);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw!.toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new BadRequestException('META_BODY_INVALID');
    }
    if (
      !body ||
      body.object !== 'whatsapp_business_account' ||
      !Array.isArray(body.entry)
    )
      throw new BadRequestException('META_BODY_INVALID');
    for (const entry of body.entry as {
      id?: string;
      changes?: {
        field?: string;
        value?: {
          metadata?: { phone_number_id?: string };
          statuses?: { id?: string; status?: string }[];
        };
      }[];
    }[]) {
      if (
        !entry ||
        typeof entry !== 'object' ||
        entry.id !== c.businessAccountId ||
        !Array.isArray(entry.changes)
      )
        continue;
      for (const change of entry.changes) {
        if (!change || typeof change !== 'object') continue;
        const value = change.value;
        if (
          change.field !== 'messages' ||
          value?.metadata?.phone_number_id !== c.phoneNumberId ||
          !Array.isArray(value.statuses)
        )
          continue;
        for (const receipt of value.statuses) {
          if (
            !receipt ||
            typeof receipt !== 'object' ||
            typeof receipt.id !== 'string' ||
            receipt.id.length > 512 ||
            !['sent', 'delivered', 'read', 'failed'].includes(
              receipt.status ?? '',
            )
          )
            continue;
          const delivery = await this.db.globalCommunicationDelivery.findFirst({
            where: {
              provider: 'META',
              environment: row.environment,
              providerMessageId: receipt.id,
            },
            select: { id: true },
          });
          // A callback can beat persistence of the send response. Ask Meta to retry; never lose that receipt silently.
          if (!delivery)
            throw new ServiceUnavailableException(
              'META_RECEIPT_NOT_CORRELATED',
            );
          const target =
            receipt.status === 'read'
              ? 'READ'
              : receipt.status === 'delivered'
                ? 'DELIVERED'
                : receipt.status === 'failed'
                  ? 'FAILED'
                  : 'ACCEPTED';
          if (target === 'ACCEPTED') continue;
          const previous =
            target === 'READ' ? ['ACCEPTED', 'DELIVERED'] : ['ACCEPTED'];
          await this.db.$transaction(async (tx) => {
            const r = await tx.globalCommunicationDelivery.updateMany({
              where: {
                id: delivery.id,
                status: { in: previous as ('ACCEPTED' | 'DELIVERED')[] },
              },
              data: {
                status: target,
                lastError: target === 'FAILED' ? 'META_DELIVERY_FAILED' : null,
              },
            });
            if (r.count)
              await tx.globalCommunicationLog.create({
                data: {
                  deliveryId: delivery.id,
                  action: target,
                  code: 'META_RECEIPT',
                },
              });
          });
        }
      }
    }
    return { received: true };
  }
}
@Controller('webhooks/communication/meta')
export class MetaWebhookController {
  constructor(@Inject(MetaWebhook) private readonly service: MetaWebhook) {}
  @Get() @Header('Cache-Control', 'no-store') challenge(@Req() req: Request) {
    return this.service.challenge(req.query);
  }
  @Post() @HttpCode(200) receive(@Req() req: RawBodyRequest<Request>) {
    return this.service.receive(
      req.rawBody,
      req.headers['x-hub-signature-256'],
    );
  }
}
