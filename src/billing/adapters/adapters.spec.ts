import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { GatewayRegistry, gateways } from '../gateway.provider.js';
import { StripeAdapter } from './stripe.adapter.js';
import { AsaasAdapter } from './asaas.adapter.js';
import { MercadoPagoAdapter } from './mercado-pago.adapter.js';
import { PagBankAdapter } from './pagbank.adapter.js';
import { request, cents } from './http.js';
import type { ChargeInput, GatewayContext } from '../gateway.types.js';
const context: GatewayContext = {
  environment: 'SANDBOX',
  credentials: 'sk_test_fixture',
  webhookSecret: 'webhook-fixture-only',
};
const input: ChargeInput = {
  paymentId: 'payment-1',
  companyId: 'company-1',
  subscriptionId: 'sub-1',
  planId: 'plan-1',
  amountCents: 9900,
  currency: 'BRL',
  idempotencyKey: 'operation-1',
  billingInterval: 'MONTHLY',
  name: 'Kalend Pro',
  email: 'test@example.test',
  taxId: '00000000000',
  dueDate: '2026-09-23',
};
let network: ReturnType<typeof vi.fn>;
it('PagBank recurring signature verifies original bytes with API WEBHOOK EC key', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  const c = {
    ...context,
    recurringCredentials: 'fixture',
    webhookSecret: publicKey
      .export({ type: 'spki', format: 'der' })
      .toString('base64'),
  };
  const raw = Buffer.from(
    JSON.stringify({ event: 'refund.created', resource: { id: 'REFU_1' } }),
  );
  reply({ public_key: c.webhookSecret });
  const signature = sign('sha256', raw, privateKey).toString('base64');
  const adapter = new PagBankAdapter();
  const refund = vi
    .spyOn(adapter, 'getRefund')
    .mockResolvedValue({ eventId: 'refund:REFU_1' } as never);
  await adapter.verifyWebhook(raw, { 'x-payload-signature': signature }, c);
  expect(refund).toHaveBeenCalledOnce();
  await expect(
    adapter.verifyWebhook(
      Buffer.from(raw.toString().replace('REFU_1', 'REFU_2')),
      { 'x-payload-signature': signature },
      c,
    ),
  ).rejects.toThrow('WEBHOOK_INVALID_SIGNATURE');
  expect(refund).toHaveBeenCalledOnce();
});
function reply(body: unknown) {
  network.mockResolvedValueOnce({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  });
}
beforeEach(() => {
  network = vi.fn();
  vi.stubGlobal('fetch', network);
  vi.stubEnv('BILLING_RETURN_URL', 'https://app.example.test/billing');
  vi.stubEnv('BILLING_PUBLIC_API_URL', 'https://api.example.test');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it('registers four distinct real adapters with explicit capabilities', () => {
  expect(
    gateways.map((g) => new GatewayRegistry().get(g).constructor.name),
  ).toEqual([
    'MercadoPagoAdapter',
    'StripeAdapter',
    'PagBankAdapter',
    'AsaasAdapter',
  ]);
  expect(new PagBankAdapter().capabilities.recurring).toBe(true);
});
it.each(gateways)(
  '%s rejects unsigned webhooks without fetching or granting access',
  async (gateway) => {
    await expect(
      new GatewayRegistry()
        .get(gateway)
        .verifyWebhook(Buffer.from('{}'), {}, context),
    ).rejects.toThrow();
    expect(network).not.toHaveBeenCalled();
  },
);
it('Stripe checkout binds amount, metadata and provider idempotency key', async () => {
  reply({
    id: 'cs_1',
    livemode: false,
    url: 'https://checkout.stripe.com/pay',
  });
  await new StripeAdapter().createSubscription(input, context);
  const [url, options] = network.mock.calls[0];
  expect(url.toString()).toContain('/v1/checkout/sessions');
  expect(options.headers['Idempotency-Key']).toBe(input.idempotencyKey);
  const body = new URLSearchParams(options.body);
  expect(body.get('line_items[0][price_data][unit_amount]')).toBe('9900');
  expect(body.get('subscription_data[metadata][planId]')).toBe('plan-1');
});
it('Stripe authenticates raw bytes, rejects replay timestamps and environment mismatch', async () => {
  const raw = Buffer.from(
    JSON.stringify({
      id: 'evt_1',
      type: 'payment_intent.succeeded',
      livemode: false,
      data: { object: { id: 'pi_1' } },
    }),
  );
  const ts = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', context.webhookSecret!)
    .update(`${ts}.`)
    .update(raw)
    .digest('hex');
  reply({
    id: 'pi_1',
    livemode: false,
    status: 'succeeded',
    amount: 9900,
    currency: 'brl',
    metadata: { paymentId: 'payment-1' },
  });
  const adapter = new StripeAdapter();
  expect(
    (
      await adapter.verifyWebhook(
        raw,
        { 'stripe-signature': `t=${ts},v1=${signature}` },
        context,
      )
    )[0],
  ).toMatchObject({ status: 'APPROVED', amountCents: 9900 });
  await expect(
    adapter.verifyWebhook(
      Buffer.from('{}'),
      { 'stripe-signature': `t=${ts},v1=${signature}` },
      context,
    ),
  ).rejects.toThrow();
  await expect(
    adapter.verifyWebhook(
      raw,
      { 'stripe-signature': 't=1000000000,v1=wrong' },
      context,
    ),
  ).rejects.toThrow('WEBHOOK_EXPIRED_SIGNATURE');
  reply({ id: 'pi_1', livemode: true });
  await expect(adapter.getPayment('pi_1', context)).rejects.toThrow(
    'GATEWAY_ENVIRONMENT_MISMATCH',
  );
});
it.each(['SANDBOX', 'PRODUCTION'] as const)(
  'Asaas %s uses isolated base and access_token, creates customer and charge with independent webhook auth',
  async (environment) => {
    const adapter = new AsaasAdapter(),
      c = { ...context, environment };
    reply({ data: [] });
    reply({ id: 'cus_1' });
    reply({ id: 'pay_1', invoiceUrl: 'https://www.asaas.com/i/test' });
    await adapter.createCharge(input, c);
    expect(network.mock.calls[0][0].hostname).toBe(
      environment === 'SANDBOX' ? 'api-sandbox.asaas.com' : 'api.asaas.com',
    );
    expect(network.mock.calls[2][1].headers.access_token).toBe(c.credentials);
    const body = JSON.parse(network.mock.calls[2][1].body);
    expect(body).toMatchObject({
      value: 99,
      externalReference: input.paymentId,
    });
    expect(JSON.parse(network.mock.calls[1][1].body).notificationDisabled).toBe(
      true,
    );
  },
);
it('Asaas uses separate authToken and re-fetches authenticated current payment', async () => {
  const adapter = new AsaasAdapter();
  const raw = Buffer.from(
    JSON.stringify({
      id: 'evt_asaas',
      event: 'PAYMENT_RECEIVED',
      payment: { id: 'pay_1', value: 1 },
    }),
  );
  reply({
    id: 'pay_1',
    status: 'RECEIVED',
    value: 99,
    externalReference: 'payment-1',
  });
  expect(
    (
      await adapter.verifyWebhook(
        raw,
        { 'asaas-access-token': context.webhookSecret },
        context,
      )
    )[0],
  ).toMatchObject({ amountCents: 9900, status: 'APPROVED' });
  await expect(
    adapter.verifyWebhook(
      raw,
      { 'asaas-access-token': context.credentials },
      context,
    ),
  ).rejects.toThrow();
  await expect(
    adapter.verifyWebhook(
      raw,
      {},
      { ...context, webhookSecret: context.credentials },
    ),
  ).rejects.toThrow('WEBHOOK_SEPARATE_SECRET_REQUIRED');
});
it('Asaas recurring mandate has explicit plan interval/reference and cancellation uses DELETE', async () => {
  reply({ data: [{ id: 'cus_1' }] });
  reply({ id: 'sub_external' });
  reply({ data: [{ id: 'pay_1', invoiceUrl: 'https://asaas.com/i/test' }] });
  const adapter = new AsaasAdapter();
  await adapter.createSubscription(input, context);
  expect(JSON.parse(network.mock.calls[1][1].body)).toMatchObject({
    cycle: 'MONTHLY',
    externalReference: 'sub-1',
    value: 99,
  });
  reply({ deleted: true });
  await adapter.cancelSubscription('sub_external', context, false);
  expect(network.mock.calls[3][1].method).toBe('DELETE');
});
it('Mercado Pago signature binds query data.id and request id, then fetches payment', async () => {
  const adapter = new MercadoPagoAdapter(),
    ts = String(Date.now());
  const signature = createHmac('sha256', context.webhookSecret!)
    .update(`id:123;request-id:req-1;ts:${ts};`)
    .digest('hex');
  const raw = Buffer.from(
    JSON.stringify({
      id: 1,
      type: 'payment',
      action: 'payment.updated',
      live_mode: false,
      data: { id: '123' },
    }),
  );
  reply({
    id: 123,
    live_mode: false,
    status: 'approved',
    transaction_amount: 99,
    currency_id: 'BRL',
    external_reference: 'payment-1',
  });
  const h = {
    'x-signature': `ts=${ts},v1=${signature}`,
    'x-request-id': 'req-1',
  };
  expect(
    (await adapter.verifyWebhook(raw, h, context, { 'data.id': '123' }))[0],
  ).toMatchObject({ status: 'APPROVED', externalPaymentId: '123' });
  await expect(
    adapter.verifyWebhook(raw, h, context, { 'data.id': '456' }),
  ).rejects.toThrow();
});
it.each(['SANDBOX', 'PRODUCTION'] as const)(
  'PagBank %s validates ECDSA payload and fetches charge from fixed host',
  async (environment) => {
    const raw = Buffer.from('{"id":"CHAR_1","status":"PAID"}');
    const { publicKey, privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    });
    const signature = sign('sha256', raw, privateKey).toString('base64');
    reply({
      public_key: publicKey
        .export({ type: 'spki', format: 'der' })
        .toString('base64'),
    });
    reply({
      id: 'CHAR_1',
      reference_id: 'payment-1',
      status: 'PAID',
      amount: { value: 9900, currency: 'BRL', summary: { refunded: 0 } },
    });
    const result = await new PagBankAdapter().verifyWebhook(
      raw,
      { 'x-payload-signature': signature },
      { ...context, environment },
    );
    expect(result[0]).toMatchObject({ status: 'APPROVED', environment });
    expect(network.mock.calls[0][0].hostname).toBe(
      environment === 'SANDBOX'
        ? 'sandbox.api.pagseguro.com'
        : 'api.pagseguro.com',
    );
  },
);
it('network errors are sanitized and SSRF/redirects are blocked', async () => {
  await expect(request('https://evil.example.test', {})).rejects.toThrow(
    'GATEWAY_REQUEST_FAILED',
  );
  expect(network).not.toHaveBeenCalled();
  network.mockRejectedValue(new Error('private secret contents'));
  await expect(new AsaasAdapter().test(context)).rejects.toThrow(
    'GATEWAY_REQUEST_FAILED',
  );
  expect(network.mock.calls[0][1].redirect).toBe('error');
});
it.each([NaN, -1, 1.234, '1e5', Infinity])(
  'rejects invalid money %s',
  (value) => {
    expect(() => cents(value, true)).toThrow();
  },
);
it('PagBank recurrence remains unavailable without explicit account configuration', async () => {
  await expect(
    new PagBankAdapter().createSubscription(input, context),
  ).rejects.toThrow('PAGBANK_RECURRING_CONFIGURATION_REQUIRED');
  expect(network).not.toHaveBeenCalled();
});
it('PagBank recurring checkout uses documented recurrence_plan and cancels through separate API', async () => {
  const c = {
    ...context,
    recurringEnabled: true,
    recurringCredentials: 'recurring-fixture',
  };
  reply({
    id: 'CHEC_recurring',
    links: [
      {
        rel: 'PAY',
        href: 'https://pagamento.pagbank.com.br/pagamento?code=fixture',
      },
    ],
  });
  const adapter = new PagBankAdapter();
  await adapter.createSubscription(input, c);
  expect(JSON.parse(network.mock.calls[0][1].body).recurrence_plan).toEqual({
    name: 'Kalend Pro',
    interval: { unit: 'MONTH', length: 1 },
  });
  reply({});
  await adapter.cancelSubscription('SUBS_1', c, false);
  expect(network.mock.calls[1][0].hostname).toBe(
    'sandbox.api.assinaturas.pagseguro.com',
  );
  expect(network.mock.calls[1][1].headers.Authorization).toBe(
    'Bearer recurring-fixture',
  );
  expect(network.mock.calls[1][1].headers['x-idempotency-key']).toMatch(
    /^[0-9a-f]{64}$/,
  );
});
it('Stripe invoice payment normalization uses invoice identity and refunded aggregate', async () => {
  reply({
    id: 'in_1',
    livemode: false,
    status: 'paid',
    total: 9900,
    currency: 'brl',
    parent: {
      subscription_details: {
        subscription: 'sub_external',
        metadata: { paymentId: 'payment-1' },
      },
    },
    lines: { data: [{ period: { start: 1800000000, end: 1802678400 } }] },
  });
  reply({
    data: [
      {
        livemode: false,
        payment: { type: 'payment_intent', payment_intent: 'pi_1' },
      },
    ],
  });
  reply({
    id: 'pi_1',
    livemode: false,
    status: 'succeeded',
    amount: 9900,
    currency: 'brl',
    latest_charge: { amount_refunded: 100 },
  });
  expect(await new StripeAdapter().getPayment('in_1', context)).toMatchObject({
    externalPaymentId: 'in_1',
    externalSubscriptionId: 'sub_external',
    status: 'REFUNDED',
    refundedAmountCents: 100,
  });
});
it('PagBank recurring refund has stable provider refund identity and delta amount', async () => {
  reply({
    id: 'REFU_1',
    status: 'SUCCESS',
    payment: { id: 'PAYM_1' },
    amount: { value: 100, currency: 'BRL' },
  });
  reply({ id: 'PAYM_1', invoice: { id: 'INVO_1' } });
  reply({
    id: 'INVO_1',
    status: 'PAID',
    occurrence: 1,
    subscription: { id: 'SUBS_1' },
    amount: { value: 9900, currency: 'BRL' },
  });
  const e = await new PagBankAdapter().getRefund('REFU_1', {
    ...context,
    recurringCredentials: 'recurring-fixture',
  });
  expect(e).toMatchObject({
    externalPaymentId: 'INVO_1',
    eventId: 'refund:REFU_1',
    refundIsDelta: true,
    refundedAmountCents: 100,
  });
});
