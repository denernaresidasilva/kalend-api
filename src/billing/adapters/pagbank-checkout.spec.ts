import { PagBankAdapter } from './pagbank.adapter.js';
import type { ChargeInput, GatewayContext } from '../gateway.types.js';
const input: ChargeInput = {
  paymentId: '11111111-1111-4111-8111-111111111111',
  companyId: '22222222-2222-4222-8222-222222222222',
  subscriptionId: '33333333-3333-4333-8333-333333333333',
  planId: '44444444-4444-4444-8444-444444444444',
  amountCents: 199,
  currency: 'BRL',
  idempotencyKey: 'test-only',
  billingInterval: 'MONTHLY',
  name: 'Kalend MONTHLY',
  email: 'test@example.invalid',
  dueDate: '2026-09-30',
};
const context: GatewayContext = {
  environment: 'SANDBOX',
  credentials: 'fixture',
};
let network: ReturnType<typeof vi.fn>;
beforeEach(() => {
  network = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        id: 'CHEC_fixture',
        links: [
          {
            rel: 'PAY',
            href: 'https://pagamento.pagbank.com.br/pagamento?code=fixture',
          },
        ],
      }),
  });
  vi.stubGlobal('fetch', network);
  vi.stubEnv('BILLING_PUBLIC_API_URL', 'https://api-dev.kalend.tech');
  vi.stubEnv('BILLING_RETURN_URL', 'https://dev.kalend.tech/pagamento/retorno');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.each([
  [
    'SANDBOX',
    'https://api-dev.kalend.tech',
    'https://sandbox.api.pagseguro.com/checkouts',
  ],
  [
    'PRODUCTION',
    'https://api.example.invalid',
    'https://api.pagseguro.com/checkouts',
  ],
] as const)(
  'serializes independent checkout/payment notifications from server configuration in %s',
  async (environment, base, api) => {
    vi.stubEnv('BILLING_PUBLIC_API_URL', base + '/ignored/base?ignored=1');
    await new PagBankAdapter().createCharge(input, { ...context, environment });
    const [url, request] = network.mock.calls[0];
    expect(url.href).toBe(api);
    expect(request.method).toBe('POST');
    const body = JSON.parse(request.body);
    expect(body.notification_urls).toEqual([base + '/webhooks/pagbank']);
    expect(body.payment_notification_urls).toEqual([
      base + '/webhooks/pagbank',
    ]);
    expect(body.reference_id).toBe(input.paymentId);
    expect(body.items[0].unit_amount).toBe(199);
    expect(body.redirect_url).toBe(
      `https://dev.kalend.tech/pagamento/retorno?paymentId=${input.paymentId}`,
    );
    expect(body.return_url).toBe(body.redirect_url);
    expect(body).not.toHaveProperty('status');
  },
);
it('sets both notifications for recurring checkout without changing credit-card-only contract', async () => {
  await new PagBankAdapter().createSubscription(input, {
    ...context,
    recurringEnabled: true,
    recurringCredentials: 'fixture-recurring',
  });
  const body = JSON.parse(network.mock.calls[0][1].body);
  expect(body.notification_urls).toEqual([
    'https://api-dev.kalend.tech/webhooks/pagbank',
  ]);
  expect(body.payment_notification_urls).toEqual(body.notification_urls);
  expect(body.payment_methods).toEqual([{ type: 'CREDIT_CARD' }]);
  expect(body.recurrence_plan.interval).toEqual({ unit: 'MONTH', length: 1 });
});
it.each([
  ['BILLING_PUBLIC_API_URL', 'http://api-dev.kalend.tech'],
  ['BILLING_RETURN_URL', 'http://dev.kalend.tech/pagamento/retorno'],
  ['BILLING_PUBLIC_API_URL', 'https://user:password@example.invalid'],
  ['BILLING_RETURN_URL', 'https://dev.kalend.tech/retorno#fragment'],
  ['BILLING_PUBLIC_API_URL', ''],
  ['BILLING_RETURN_URL', ''],
])('fails closed before network for invalid %s = %s', async (name, value) => {
  vi.stubEnv(name, value);
  await expect(
    new PagBankAdapter().createCharge(input, context),
  ).rejects.toThrow();
  expect(network).not.toHaveBeenCalled();
});
it.each([
  [
    'BILLING_PUBLIC_API_URL',
    `https://${'a'.repeat(63)}.${'b'.repeat(40)}.invalid`,
  ],
  ['BILLING_RETURN_URL', `https://dev.kalend.tech/${'a'.repeat(240)}`],
])(
  'enforces documented PagBank URL limits before external creation: %s',
  async (name, value) => {
    vi.stubEnv(name, value);
    await expect(
      new PagBankAdapter().createCharge(input, context),
    ).rejects.toThrow('PAGBANK_CHECKOUT_URL_INVALID');
    expect(network).not.toHaveBeenCalled();
  },
);
it('overwrites correlation supplied in server URL with the actual internal payment; ignores extra input URLs', async () => {
  vi.stubEnv(
    'BILLING_RETURN_URL',
    'https://dev.kalend.tech/pagamento/retorno?paymentId=wrong',
  );
  await new PagBankAdapter().createCharge(
    {
      ...input,
      redirect_url: 'https://evil.invalid',
      payment_notification_urls: ['https://evil.invalid'],
    } as ChargeInput,
    context,
  );
  const body = JSON.parse(network.mock.calls[0][1].body);
  expect(body.redirect_url).toBe(
    `https://dev.kalend.tech/pagamento/retorno?paymentId=${input.paymentId}`,
  );
  expect(body.payment_notification_urls).toEqual([
    'https://api-dev.kalend.tech/webhooks/pagbank',
  ]);
});
