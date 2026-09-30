import {
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';
import { PagBankAdapter } from './pagbank.adapter.js';
import { Logger } from '@nestjs/common';
import type { GatewayContext } from '../gateway.types.js';
const c: GatewayContext = {
  environment: 'SANDBOX',
  credentials: 'fixture',
  recurringCredentials: 'fixture-recurring',
};
const raw = Buffer.from('{\n "id": "CHEC_1", "label": "ação"\n}');
function pair() {
  return generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
}
const first = pair(),
  second = pair();
const signature = (key = first, body = raw) =>
  sign('sha256', body, key.privateKey).toString('base64');
const publicKey = (key = first) =>
  key.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
let network: ReturnType<typeof vi.fn>;
let adapter: PagBankAdapter;
let warning: ReturnType<typeof vi.spyOn>;
function reply(body: unknown) {
  network.mockResolvedValueOnce({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  });
}
beforeEach(() => {
  warning = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  adapter = new PagBankAdapter();
  network = vi.fn();
  vi.stubGlobal('fetch', network);
});
afterEach(() => {
  warning.mockRestore();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function paddedSignature() {
  const value = Array.from({ length: 32 }, () => signature()).find((s) =>
    s.endsWith('='),
  );
  expect(value).toBeDefined();
  return value!;
}
it('accepts a cryptographically valid unpadded Base64 signature rejected by the 88c979e parser', async () => {
  const padded = paddedSignature(),
    unpadded = padded.replace(/=+$/, '');
  const oldFormat =
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  expect(oldFormat.test(padded)).toBe(true);
  expect(oldFormat.test(unpadded)).toBe(false);
  expect(Buffer.from(unpadded, 'base64')).toEqual(
    Buffer.from(padded, 'base64'),
  );
  expect(
    verify('sha256', raw, first.publicKey, Buffer.from(unpadded, 'base64')),
  ).toBe(true);
  reply({ public_key: publicKey() });
  await expect(
    adapter.verifyWebhook(raw, { 'x-payload-signature': unpadded }, c),
  ).resolves.toEqual([]);
  await expect(
    adapter.verifyWebhook(
      Buffer.from(raw.toString().replace('ação', 'outra')),
      { 'x-payload-signature': unpadded },
      c,
    ),
  ).rejects.toMatchObject({ response: { reason: 'SIGNATURE_MISMATCH' } });
});
it('accepts one valid unpadded signature among repeated/comma separated values', async () => {
  reply({ public_key: publicKey() });
  await expect(
    adapter.verifyWebhook(
      raw,
      {
        'x-payload-signature': [
          'bad!',
          signature(second),
          paddedSignature().replace(/=+$/, ''),
        ],
      },
      c,
    ),
  ).resolves.toEqual([]);
});
it.each([
  'A',
  'AA===',
  'Zh',
  'Zm9',
  '-_',
  'Z g==',
  'Zg==garbage',
  'a'.repeat(16385),
])(
  'rejects invalid/noncanonical signature encoding before key fetch: %s',
  async (value) => {
    await expect(
      adapter.verifyWebhook(raw, { 'x-payload-signature': value }, c),
    ).rejects.toMatchObject({
      response: {
        statusCode: 401,
        message: 'WEBHOOK_INVALID_SIGNATURE',
        reason: 'SIGNATURE_ENCODING_INVALID',
      },
    });
    expect(network).not.toHaveBeenCalled();
  },
);
it('returns bounded diagnostics without header values/body/tokens and keeps legacy-only requests rejected', async () => {
  await expect(
    adapter.verifyWebhook(raw, { 'x-authenticity-token': 'not-accepted' }, c),
  ).rejects.toMatchObject({
    response: { statusCode: 401, reason: 'SIGNATURE_MISSING' },
  });
  await expect(
    adapter.verifyWebhook(
      raw,
      { 'x-payload-signature': Array(17).fill('Zg==') },
      c,
    ),
  ).rejects.toMatchObject({ response: { reason: 'SIGNATURE_LIMIT' } });
  reply({ public_key: publicKey() });
  await expect(
    adapter.verifyWebhook(raw, { 'x-payload-signature': signature(second) }, c),
  ).rejects.toMatchObject({ response: { reason: 'SIGNATURE_MISMATCH' } });
  expect(warning.mock.calls.map((call: unknown[]) => call[0])).toEqual(
    ['SIGNATURE_MISSING', 'SIGNATURE_LIMIT', 'SIGNATURE_MISMATCH'].map(
      (reason) => ({
        event: 'PAGBANK_WEBHOOK_REJECTED',
        environment: 'SANDBOX',
        reason,
      }),
    ),
  );
});
it('DER/SPKI key and the official PEM representation verify the exact same DER ECDSA bytes', () => {
  const der = Buffer.from(publicKey(), 'base64');
  const pem = `-----BEGIN PUBLIC KEY-----\n${publicKey()
    .match(/.{1,64}/g)!
    .join('\n')}\n-----END PUBLIC KEY-----`;
  const value = Buffer.from(signature(), 'base64');
  expect(
    verify(
      'sha256',
      raw,
      createPublicKey({ key: der, format: 'der', type: 'spki' }),
      value,
    ),
  ).toBe(true);
  expect(verify('sha256', raw, pem, value)).toBe(true);
});
it('selects the Sandbox WEBHOOK host and isolates the Production key using only outbound Bearer credentials', async () => {
  reply({ public_key: publicKey() });
  await adapter.verifyWebhook(raw, { 'x-payload-signature': signature() }, c);
  reply({ public_key: publicKey(second) });
  await adapter.verifyWebhook(
    raw,
    { 'x-payload-signature': signature(second) },
    { ...c, environment: 'PRODUCTION' },
  );
  expect(network.mock.calls.map(([url]) => url.href)).toEqual([
    'https://sandbox.api.pagseguro.com/public-keys/webhook',
    'https://api.pagseguro.com/public-keys/webhook',
  ]);
  for (const [, request] of network.mock.calls)
    expect(request.headers.Authorization).toBe('Bearer fixture');
});
it('obtains WEBHOOK SPKI EC key with Bearer and verifies untouched UTF-8 bytes', async () => {
  reply({ public_key: publicKey() });
  await expect(
    adapter.verifyWebhook(raw, { 'x-payload-signature': signature() }, c),
  ).resolves.toEqual([]);
  expect(network.mock.calls[0][0].toString()).toBe(
    'https://sandbox.api.pagseguro.com/public-keys/webhook',
  );
  expect(network.mock.calls[0][1].headers.Authorization).toBe('Bearer fixture');
  expect(network.mock.calls[0][1].redirect).toBe('error');
  await expect(
    adapter.verifyWebhook(
      Buffer.from(JSON.stringify(JSON.parse(raw.toString()))),
      { 'x-payload-signature': signature() },
      c,
    ),
  ).rejects.toThrow('WEBHOOK_INVALID_SIGNATURE');
});
it.each([undefined, '', '  ', 'bad-base64!', []])(
  'rejects missing/invalid signatures without querying key: %j',
  async (value) => {
    await expect(
      adapter.verifyWebhook(raw, { 'x-payload-signature': value }, c),
    ).rejects.toThrow('WEBHOOK_INVALID_SIGNATURE');
    expect(network).not.toHaveBeenCalled();
  },
);
it.each([
  () => `${signature(second)},${signature()}`,
  () => ['bad-base64!', `${signature(second)}, ${signature()}`],
])(
  'accepts one valid signature among multiple header values',
  async (values) => {
    reply({ public_key: publicKey() });
    await expect(
      adapter.verifyWebhook(raw, { 'x-payload-signature': values() }, c),
    ).resolves.toEqual([]);
  },
);
it('rejects all invalid signatures and never falls back to configured secret or old hash', async () => {
  reply({ public_key: publicKey() });
  await expect(
    adapter.verifyWebhook(
      raw,
      {
        'x-payload-signature': [signature(second), signature(second)],
        'x-authenticity-token': 'fixture',
      },
      { ...c, webhookSecret: publicKey(second) },
    ),
  ).rejects.toThrow('WEBHOOK_INVALID_SIGNATURE');
  await expect(
    adapter.verifyWebhook(raw, { 'x-authenticity-token': 'fixture' }, c),
  ).rejects.toThrow('WEBHOOK_INVALID_SIGNATURE');
});
it.each(['invalid', '', undefined])(
  'rejects invalid public key %j',
  async (key) => {
    reply({ public_key: key });
    await expect(
      adapter.verifyWebhook(raw, { 'x-payload-signature': signature() }, c),
    ).rejects.toThrow('PAGBANK_WEBHOOK_KEY_UNAVAILABLE');
  },
);
it('rejects RSA card key returned by webhook endpoint', async () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  reply({
    public_key: rsa.publicKey
      .export({ format: 'der', type: 'spki' })
      .toString('base64'),
  });
  await expect(adapter.test(c)).rejects.toThrow(
    'PAGBANK_WEBHOOK_KEY_UNAVAILABLE',
  );
  expect(network.mock.calls[0][0].pathname).toBe('/public-keys/webhook');
});
it('sanitizes key fetch failure without a trusted cache', async () => {
  network.mockRejectedValue(new Error('sensitive remote contents'));
  await expect(
    adapter.verifyWebhook(raw, { 'x-payload-signature': signature() }, c),
  ).rejects.toThrow('PAGBANK_WEBHOOK_KEY_UNAVAILABLE');
});
it('caches keys, refreshes on rotation and limits refresh frequency', async () => {
  vi.useFakeTimers();
  reply({ public_key: publicKey() });
  await adapter.verifyWebhook(raw, { 'x-payload-signature': signature() }, c);
  await adapter.verifyWebhook(raw, { 'x-payload-signature': signature() }, c);
  expect(network).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(31000);
  reply({ public_key: publicKey(second) });
  await adapter.verifyWebhook(
    raw,
    { 'x-payload-signature': signature(second) },
    c,
  );
  expect(network).toHaveBeenCalledTimes(2);
  await expect(
    adapter.verifyWebhook(raw, { 'x-payload-signature': signature() }, c),
  ).rejects.toThrow('WEBHOOK_INVALID_SIGNATURE');
  expect(network).toHaveBeenCalledTimes(2);
});
it('does not accept invalid signatures on refresh failure or expired cached keys', async () => {
  vi.useFakeTimers();
  reply({ public_key: publicKey() });
  await adapter.verifyWebhook(raw, { 'x-payload-signature': signature() }, c);
  vi.advanceTimersByTime(31000);
  network.mockRejectedValue(new Error('private remote failure'));
  await expect(
    adapter.verifyWebhook(raw, { 'x-payload-signature': signature(second) }, c),
  ).rejects.toThrow('WEBHOOK_INVALID_SIGNATURE');
  await adapter.verifyWebhook(raw, { 'x-payload-signature': signature() }, c);
  vi.advanceTimersByTime(300000);
  await expect(
    adapter.verifyWebhook(raw, { 'x-payload-signature': signature() }, c),
  ).rejects.toThrow('PAGBANK_WEBHOOK_KEY_UNAVAILABLE');
});
it('isolates cache on credential change and coalesces concurrent key requests', async () => {
  reply({ public_key: publicKey() });
  await Promise.all(
    [1, 2].map(() =>
      adapter.verifyWebhook(raw, { 'x-payload-signature': signature() }, c),
    ),
  );
  expect(network).toHaveBeenCalledTimes(1);
  reply({ public_key: publicKey(second) });
  await adapter.verifyWebhook(
    raw,
    { 'x-payload-signature': signature(second) },
    { ...c, credentials: 'new-fixture' },
  );
  expect(network).toHaveBeenCalledTimes(2);
});
it('reports capabilities without claiming financial or webhook homologation', async () => {
  reply({ public_key: publicKey() });
  reply({});
  expect(await adapter.test({ ...c, recurringEnabled: true })).toEqual({
    credentials: 'CREDENTIALS_VALID',
    webhookKey: 'WEBHOOK_KEY_AVAILABLE',
    webhook: 'UNVERIFIED',
    recurring: 'RECURRING_AVAILABLE',
    reconciliation: 'RECONCILIATION_UNVERIFIED',
  });
  expect(network.mock.calls[1][0].pathname).toBe('/subscriptions');
});
it.each([
  {},
  { status: 'PAID' },
  { reference_id: 'payment', payments: [{ id: 'CHAR_1' }] },
  { payments: Array.from({ length: 100 }, () => ({ id: 'CHAR_1' })) },
])(
  'checkout unknown contract never returns financial events: %j',
  async (body) => {
    reply(body);
    await expect(
      adapter.reconcile(
        {
          paymentId: 'payment',
          externalPaymentId: null,
          externalCheckoutId: 'CHEC_1',
        },
        c,
      ),
    ).rejects.toThrow('PAGBANK_CHECKOUT_CONTRACT_UNVERIFIED');
    expect(network).toHaveBeenCalledTimes(1);
    expect(network.mock.calls[0][0].search).toBe('?limit=100&offset=0');
  },
);
it.each([
  {},
  { invoices: [] },
  { invoices: [{ id: 'INVO_1', status: 'PAID' }] },
  { invoices: Array.from({ length: 100 }, () => ({ id: 'INVO_1' })) },
])(
  'invoices unknown envelope cannot update Payment/Subscription: %j',
  async (body) => {
    reply(body);
    await expect(
      adapter.reconcile(
        {
          paymentId: 'payment',
          externalPaymentId: null,
          externalCheckoutId: null,
          externalSubscriptionId: 'SUBS_1',
        },
        c,
      ),
    ).rejects.toThrow('PAGBANK_INVOICES_CONTRACT_UNVERIFIED');
    expect(network).toHaveBeenCalledTimes(1);
    expect(network.mock.calls[0][0].search).toBe('?limit=100&offset=0');
    expect(network.mock.calls[0][1].headers.Authorization).toBe(
      'Bearer fixture-recurring',
    );
  },
);
it('rejects mismatched requested financial ID and internal reference', async () => {
  reply({ id: 'CHAR_other' });
  await expect(adapter.getPayment('CHAR_1', c)).rejects.toThrow(
    'GATEWAY_REFERENCE_MISMATCH',
  );
  reply({
    id: 'CHAR_1',
    status: 'PAID',
    reference_id: 'other',
    amount: { value: 9900, currency: 'BRL' },
  });
  await expect(
    adapter.reconcile(
      {
        paymentId: 'payment',
        externalPaymentId: 'CHAR_1',
        externalCheckoutId: null,
      },
      c,
    ),
  ).rejects.toThrow('GATEWAY_REFERENCE_MISMATCH');
});
