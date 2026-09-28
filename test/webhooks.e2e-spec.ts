import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { SecretVault } from '../src/billing/secret-vault.js';
import { WebhookProcessor } from '../src/billing/webhook-processor.service.js';
describe('external webhook HTTP authentication and raw body', () => {
  let app: INestApplication,
    process: ReturnType<typeof vi.spyOn>,
    network: ReturnType<typeof vi.fn>;
  const secret = 'test-only-webhook-secret';
  beforeAll(async () => {
    vi.stubEnv('GATEWAY_ENCRYPTION_KEY', 'cd'.repeat(32));
    const vault = new SecretVault();
    const fixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({
        gatewayConfiguration: {
          findUnique: async ({ where }: { where: { gateway: string } }) => ({
            enabled: false,
            environment: 'SANDBOX',
            credentialsEncrypted: vault.encrypt(
              'sk_test_fixture',
              `${where.gateway}:SANDBOX:credentials`,
            ),
            webhookSecretEncrypted: vault.encrypt(
              secret,
              `${where.gateway}:SANDBOX:webhookSecret`,
            ),
          }),
        },
      })
      .compile();
    app = fixture.createNestApplication({ rawBody: true });
    await app.init();
    process = vi
      .spyOn(app.get(WebhookProcessor), 'processVerified')
      .mockResolvedValue({ id: 'event', duplicate: true });
    network = vi.fn();
    vi.stubGlobal('fetch', network);
  });
  beforeEach(() => {
    network.mockReset();
    process.mockClear();
  });
  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  function signed(raw: string) {
    const ts = String(Math.floor(Date.now() / 1000));
    return `t=${ts},v1=${createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex')}`;
  }
  it('accepts correctly signed event without JWT even when creation of new checkouts is disabled', async () => {
    const raw =
      '{ "id":"evt_1", "livemode":false,"type":"payment_intent.succeeded","data":{"object":{"id":"pi_1"}} }';
    network.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          id: 'pi_1',
          status: 'succeeded',
          livemode: false,
          amount: 9900,
          currency: 'brl',
        }),
    });
    await request(app.getHttpServer())
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', signed(raw))
      .send(raw)
      .expect(200);
    expect(process).toHaveBeenCalledWith(
      'STRIPE',
      expect.objectContaining({ status: 'APPROVED', amountCents: 9900 }),
    );
  });
  it('rejects forged or reformatted body before provider query or transaction', async () => {
    await request(app.getHttpServer())
      .post('/webhooks/stripe')
      .set('Stripe-Signature', signed('{ }'))
      .send({})
      .expect(401);
    expect(network).not.toHaveBeenCalled();
    expect(process).not.toHaveBeenCalled();
  });
  it('PagBank HTTP preserves whitespace, newlines and UTF-8 through ECDSA verification', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    });
    const raw = '{\n "id": "CHAR_http", "label": "ação"\n}';
    const signature = sign('sha256', Buffer.from(raw), privateKey).toString(
      'base64',
    );
    const receive = vi.spyOn(app.get(WebhookProcessor), 'receive');
    network.mockImplementation(async (url: URL) => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify(
          url.pathname === '/public-keys/webhook'
            ? {
                public_key: publicKey
                  .export({ format: 'der', type: 'spki' })
                  .toString('base64'),
              }
            : {
                id: 'CHAR_http',
                reference_id: 'payment',
                status: 'PAID',
                amount: { value: 9900, currency: 'BRL' },
              },
        ),
    }));
    await request(app.getHttpServer())
      .post('/webhooks/pagbank')
      .set('Content-Type', 'application/json')
      .set('x-payload-signature', `bad!, ${signature}`)
      .send(raw)
      .expect(200);
    expect(receive.mock.calls.at(-1)?.[1]).toEqual(Buffer.from(raw));
    expect(process).toHaveBeenCalledWith(
      'PAGBANK',
      expect.objectContaining({ status: 'APPROVED' }),
    );
    process.mockClear();
    await request(app.getHttpServer())
      .post('/webhooks/pagbank')
      .set('Content-Type', 'application/json')
      .set('x-payload-signature', signature)
      .send(JSON.parse(raw))
      .expect(401);
    await request(app.getHttpServer())
      .post('/webhooks/pagbank')
      .send(JSON.parse(raw))
      .expect(401);
    expect(process).not.toHaveBeenCalled();
    receive.mockRestore();
  });
});
