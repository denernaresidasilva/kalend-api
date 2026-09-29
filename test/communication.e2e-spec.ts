import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createHmac, randomBytes } from 'node:crypto';
import {
  MetaWebhook,
  MetaWebhookController,
} from '../src/communication/meta-webhook.js';
import { MetaTemplates } from '../src/communication/meta.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
describe('Meta global receipt HTTP uses original bytes', () => {
  let app: INestApplication;
  let status = 'ACCEPTED';
  const secret = randomBytes(32).toString('hex');
  const db = {
    globalCommunicationDelivery: {
      findFirst: vi.fn().mockResolvedValue({ id: 'delivery' }),
      updateMany: vi.fn(async ({ where, data }) => {
        if (!where.status.in.includes(status)) return { count: 0 };
        status = data.status;
        return { count: 1 };
      }),
    },
    globalCommunicationLog: { create: vi.fn() },
    $transaction: vi.fn(),
  };
  beforeAll(async () => {
    db.$transaction.mockImplementation((fn) => fn(db));
    const module = await Test.createTestingModule({
      controllers: [MetaWebhookController],
      providers: [
        MetaWebhook,
        {
          provide: MetaTemplates,
          useValue: {
            context: async () => ({
              row: { environment: 'SANDBOX' },
              c: { businessAccountId: '123', phoneNumberId: '456' },
              s: { appSecret: secret, verifyToken: 'test-only' },
            }),
          },
        },
        { provide: PrismaService, useValue: db },
      ],
    }).compile();
    app = module.createNestApplication({ rawBody: true });
    await app.init();
  });
  beforeEach(() => {
    status = 'ACCEPTED';
    db.globalCommunicationLog.create.mockClear();
  });
  afterAll(async () => {
    await app.close();
  });
  const raw =
    '{\n "object":"whatsapp_business_account", "entry":[{"id":"123","changes":[{"field":"messages","value":{"metadata":{"phone_number_id":"456"},"statuses":[{"id":"wamid.test","status":"delivered"}]}}]}], "extra":"ação"\n}';
  const signed = (s: string) =>
    'sha256=' + createHmac('sha256', secret).update(s).digest('hex');
  it('accepts signed raw UTF-8 without JWT and deduplicates replay', async () => {
    for (let i = 0; i < 2; i++)
      await request(app.getHttpServer())
        .post('/webhooks/communication/meta')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', signed(raw))
        .send(raw)
        .expect(200);
    expect(status).toBe('DELIVERED');
    expect(db.globalCommunicationLog.create).toHaveBeenCalledTimes(1);
  });
  it('rejects reserialized body signed over different bytes before delivery mutation', async () => {
    await request(app.getHttpServer())
      .post('/webhooks/communication/meta')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', signed(raw))
      .send(JSON.stringify(JSON.parse(raw)))
      .expect(401);
    expect(status).toBe('ACCEPTED');
  });
  it('returns challenge only for configured verification token', async () => {
    const r = await request(app.getHttpServer())
      .get('/webhooks/communication/meta')
      .query({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'test-only',
        'hub.challenge': '987',
      })
      .expect(200);
    expect(r.text).toBe('987');
    expect(r.headers['cache-control']).toBe('no-store');
  });
});
