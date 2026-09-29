import { createHmac, randomBytes } from 'node:crypto';
import { MetaWebhook, verifyMetaSignature } from './meta-webhook.js';
const secret = randomBytes(32).toString('hex');
const encode = (body: unknown) => Buffer.from(JSON.stringify(body));
const signature = (raw: Buffer) =>
  'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
function setup() {
  let state = 'ACCEPTED';
  const db = {
    globalCommunicationDelivery: {
      findFirst: vi.fn().mockResolvedValue({ id: 'delivery' }),
      updateMany: vi.fn(async ({ where, data }) => {
        if (!where.status.in.includes(state)) return { count: 0 };
        state = data.status;
        return { count: 1 };
      }),
    },
    globalCommunicationLog: { create: vi.fn() },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation((fn) => fn(db));
  const meta = {
    context: vi.fn().mockResolvedValue({
      row: { environment: 'SANDBOX' },
      c: { businessAccountId: 'waba', phoneNumberId: 'phone' },
      s: { appSecret: secret, verifyToken: 'test-verification-token' },
    }),
  };
  const service = new MetaWebhook(meta as never, db as never);
  return { service, db, state: () => state };
}
function body(status: string, waba = 'waba', phone = 'phone') {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: waba,
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: phone },
              statuses: [
                { id: 'wamid.example', status, timestamp: '1603086313' },
              ],
            },
          },
        ],
      },
    ],
  };
}
describe('Meta authenticated global receipts', () => {
  it('verifies exact bytes and rejects tampering/absence/oversized signature', () => {
    const raw = Buffer.from('{ "hello": "world" }');
    expect(() =>
      verifyMetaSignature(raw, signature(raw), secret),
    ).not.toThrow();
    for (const sig of [
      undefined,
      'bad',
      'sha256=' + 'a'.repeat(64),
      signature(encode({ hello: 'world' })),
    ])
      expect(() => verifyMetaSignature(raw, sig, secret)).toThrow();
    expect(() =>
      verifyMetaSignature(Buffer.alloc(262145), signature(raw), secret),
    ).toThrow();
  });
  it('uses independent verification token and returns challenge only', async () => {
    const { service } = setup();
    expect(
      await service.challenge({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'test-verification-token',
        'hub.challenge': '123',
      }),
    ).toBe('123');
    await expect(
      service.challenge({
        'hub.mode': 'subscribe',
        'hub.verify_token': secret,
        'hub.challenge': '123',
      }),
    ).rejects.toThrow();
  });
  it('handles out-of-order receipts and replay without duplicate log/state regression', async () => {
    const { service, db, state } = setup();
    for (const status of ['read', 'delivered', 'read', 'sent', 'failed']) {
      const raw = encode(body(status));
      await service.receive(raw, signature(raw));
    }
    expect(state()).toBe('READ');
    expect(db.globalCommunicationLog.create).toHaveBeenCalledTimes(1);
  });
  it('does not trust another WABA or phone and never touches financial data', async () => {
    const { service, db } = setup();
    for (const b of [body('read', 'other'), body('read', 'waba', 'other')]) {
      const raw = encode(b);
      await service.receive(raw, signature(raw));
    }
    expect(db.globalCommunicationDelivery.findFirst).not.toHaveBeenCalled();
  });
  it('requests redelivery if a receipt races send persistence', async () => {
    const { service, db } = setup();
    db.globalCommunicationDelivery.findFirst.mockResolvedValue(null);
    const raw = encode(body('delivered'));
    await expect(service.receive(raw, signature(raw))).rejects.toThrow(
      'META_RECEIPT_NOT_CORRELATED',
    );
  });
  it('rejects spoofing before parsing or updating delivery', async () => {
    const { service, db } = setup();
    await expect(
      service.receive(encode(body('delivered')), 'bad'),
    ).rejects.toThrow();
    expect(db.globalCommunicationDelivery.findFirst).not.toHaveBeenCalled();
  });
});
