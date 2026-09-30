import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify,
  type KeyObject,
} from 'node:crypto';
import {
  BadRequestException,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type {
  ChargeInput,
  GatewayContext,
  GatewayProvider,
  Headers,
  ProviderEvent,
  SubscriptionEvent,
  VerifiedEvent,
} from '../gateway.types.js';
import {
  callback,
  cents,
  checkoutUrl,
  eventId,
  id,
  json,
  request,
  returnUrl,
} from './http.js';
import type { Remote } from './http.js';
export class PagBankAdapter implements GatewayProvider {
  private readonly logger = new Logger('PagBankWebhook');
  readonly capabilities = {
    checkout: true,
    recurring: true,
    nativeIdempotency: false,
    cancelAtPeriodEnd: false,
    webhookManagement: false,
    limitation:
      'Recorrência exige habilitação da conta, token próprio; chave WEBHOOK obtida pela API; reconciliação de checkout/faturas não homologada; cartão de crédito, sem cancelamento ao fim do período.',
  };
  private api(c: GatewayContext, path: string, method = 'GET', body?: Remote) {
    return request(
      `https://${c.environment === 'SANDBOX' ? 'sandbox.' : ''}api.pagseguro.com${path}`,
      { Authorization: `Bearer ${c.credentials}` },
      method,
      body,
    );
  }
  // Public material only; scope includes credentials/configuration without retaining tokens.
  private readonly keys = new Map<
    string,
    { key: KeyObject; expires: number; refreshAfter: number }
  >();
  private readonly loading = new Map<string, Promise<KeyObject>>();
  private scope(c: GatewayContext) {
    return createHash('sha256')
      .update(
        JSON.stringify([
          c.environment,
          c.credentials,
          c.configurationVersion?.toISOString(),
        ]),
      )
      .digest('hex');
  }
  private async webhookKey(
    c: GatewayContext,
    refresh = false,
  ): Promise<KeyObject> {
    const scope = this.scope(c),
      now = Date.now(),
      cached = this.keys.get(scope);
    if (
      cached &&
      cached.expires > now &&
      (!refresh || cached.refreshAfter > now)
    )
      return cached.key;
    const pending = this.loading.get(scope);
    if (pending) return pending;
    const fetchKey = async () => {
      try {
        const r = await this.api(c, '/public-keys/webhook');
        const bytes = this.base64(r.public_key);
        if (!bytes) throw new Error();
        const key = createPublicKey({
          key: bytes,
          format: 'der',
          type: 'spki',
        });
        if (key.asymmetricKeyType !== 'ec') throw new Error();
        if (this.keys.size >= 32)
          this.keys.delete(this.keys.keys().next().value!);
        this.keys.set(scope, {
          key,
          expires: Date.now() + 300000,
          refreshAfter: Date.now() + 30000,
        });
        return key;
      } catch {
        // An expired key is never resurrected on network failure.
        if (cached && cached.expires > Date.now()) {
          cached.refreshAfter = Date.now() + 30000;
          return cached.key;
        }
        throw new ServiceUnavailableException(
          'PAGBANK_WEBHOOK_KEY_UNAVAILABLE',
        );
      } finally {
        this.loading.delete(scope);
      }
    };
    const promise = fetchKey();
    this.loading.set(scope, promise);
    return promise;
  }
  private base64(value: unknown, unpadded = false): Buffer | null {
    // Some Base64 encoders omit padding. Normalize that representation only;
    // alphabet, unused bits and the mandatory ECDSA verification stay strict.
    if (
      unpadded &&
      typeof value === 'string' &&
      value.length <= 16384 &&
      /^[A-Za-z0-9+/]+$/.test(value) &&
      value.length % 4 !== 1
    )
      value = value.padEnd(Math.ceil(value.length / 4) * 4, '=');
    if (
      typeof value !== 'string' ||
      value.length > 16384 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        value,
      ) ||
      !value
    )
      return null;
    const bytes = Buffer.from(value, 'base64');
    return bytes.toString('base64') === value ? bytes : null;
  }
  async test(c: GatewayContext) {
    await this.webhookKey(c, true);
    if (c.recurringEnabled)
      await this.recurringApi(c, '/subscriptions?limit=1&offset=0');
    return {
      credentials: 'CREDENTIALS_VALID',
      webhookKey: 'WEBHOOK_KEY_AVAILABLE',
      webhook: 'UNVERIFIED',
      recurring: c.recurringEnabled ? 'RECURRING_AVAILABLE' : 'NOT_TESTED',
      reconciliation: 'RECONCILIATION_UNVERIFIED',
    };
  }
  private async checkout(
    i: ChargeInput,
    c: GatewayContext,
    recurring: boolean,
  ) {
    const notificationUrl = callback('/webhooks/pagbank');
    const redirectUrl = new URL(returnUrl());
    // Correlation for UX only. The authenticated status endpoint reads the DB.
    redirectUrl.searchParams.set('paymentId', i.paymentId);
    if (notificationUrl.length > 100 || redirectUrl.href.length > 255)
      throw new ServiceUnavailableException('PAGBANK_CHECKOUT_URL_INVALID');
    const r = await this.api(c, '/checkouts', 'POST', {
      reference_id: i.paymentId,
      ...(recurring
        ? {
            recurrence_plan: {
              name: i.name,
              interval: {
                unit: i.billingInterval === 'YEARLY' ? 'YEAR' : 'MONTH',
                length: 1,
              },
            },
            payment_methods: [{ type: 'CREDIT_CARD' }],
          }
        : {}),
      items: [
        {
          reference_id: i.planId,
          name: i.name,
          quantity: 1,
          unit_amount: i.amountCents,
        },
      ],
      redirect_url: redirectUrl.href,
      return_url: redirectUrl.href,
      // Independent PagBank contracts: checkout lifecycle and financial events.
      notification_urls: [notificationUrl],
      payment_notification_urls: [notificationUrl],
    });
    return {
      externalCheckoutId: id(r.id),
      checkoutUrl: checkoutUrl(
        r.links?.find((l: Remote) => l.rel === 'PAY')?.href,
        ['pagseguro.uol.com.br', 'pagbank.com.br'],
      ),
    };
  }
  createCharge(i: ChargeInput, c: GatewayContext) {
    return this.checkout(i, c, false);
  }
  async createSubscription(i: ChargeInput, c: GatewayContext) {
    if (!c.recurringEnabled || !c.recurringCredentials)
      throw new BadRequestException('PAGBANK_RECURRING_CONFIGURATION_REQUIRED');
    return this.checkout(i, c, true);
  }
  private recurringApi(c: GatewayContext, path: string, method = 'GET') {
    if (!c.recurringCredentials)
      throw new BadRequestException('PAGBANK_RECURRING_CONFIGURATION_REQUIRED');
    return request(
      `https://${c.environment === 'SANDBOX' ? 'sandbox.' : ''}api.assinaturas.pagseguro.com${path}`,
      {
        Authorization: `Bearer ${c.recurringCredentials}`,
        ...(method === 'PUT'
          ? {
              'x-idempotency-key': createHash('sha256')
                .update(path)
                .digest('hex'),
            }
          : {}),
      },
      method,
    );
  }
  async getSubscription(
    externalId: string,
    c: GatewayContext,
  ): Promise<SubscriptionEvent> {
    const r = await this.recurringApi(c, `/subscriptions/${id(externalId)}`);
    if (r.id !== externalId)
      throw new BadRequestException('GATEWAY_REFERENCE_MISMATCH');
    const map: Record<string, SubscriptionEvent['status']> = {
      ACTIVE: 'ACTIVE',
      PENDING: 'PENDING',
      OVERDUE: 'PAST_DUE',
      SUSPENDED: 'SUSPENDED',
      CANCELED: 'CANCELED',
      CANCELLED: 'CANCELED',
      EXPIRED: 'CANCELED',
    };
    if (!map[r.status]) throw new BadRequestException('GATEWAY_UNKNOWN_STATUS');
    return {
      kind: 'subscription',
      environment: c.environment,
      eventId: eventId(id(r.id), r.status),
      type: 'subscription',
      externalSubscriptionId: id(r.id),
      externalReference: r.reference_id,
      status: map[r.status],
    };
  }
  async cancelSubscription(
    externalId: string,
    c: GatewayContext,
    atPeriodEnd: boolean,
  ) {
    if (atPeriodEnd)
      throw new BadRequestException('GATEWAY_CAPABILITY_UNAVAILABLE');
    await this.recurringApi(
      c,
      `/subscriptions/${id(externalId)}/cancel`,
      'PUT',
    );
  }
  async getPayment(
    externalId: string,
    c: GatewayContext,
  ): Promise<VerifiedEvent> {
    if (externalId.startsWith('INVO_')) {
      const r = await this.recurringApi(c, `/invoices/${id(externalId)}`);
      if (r.id !== externalId)
        throw new BadRequestException('GATEWAY_REFERENCE_MISMATCH');
      const map: Record<string, VerifiedEvent['status']> = {
        PAID: 'APPROVED',
        UNPAID: 'FAILED',
        WAITING: 'PENDING',
        OVERDUE: 'OVERDUE',
      };
      if (
        !map[r.status] ||
        !Number.isSafeInteger(r.occurrence) ||
        r.occurrence < 1
      )
        throw new BadRequestException('GATEWAY_UNKNOWN_STATUS');
      return {
        environment: c.environment,
        eventId: eventId(id(r.id), r.status),
        type: 'invoice',
        externalPaymentId: id(r.id),
        externalSubscriptionId: id(r.subscription?.id),
        status: map[r.status],
        amountCents: cents(r.amount?.value),
        currency: r.amount?.currency,
        cycle: r.occurrence,
      };
    }

    const r = await this.api(c, `/charges/${id(externalId)}`);
    if (r.id !== externalId)
      throw new BadRequestException('GATEWAY_REFERENCE_MISMATCH');
    const map: Record<string, VerifiedEvent['status']> = {
      WAITING: 'PENDING',
      IN_ANALYSIS: 'PENDING',
      AUTHORIZED: 'PENDING',
      PAID: 'APPROVED',
      DECLINED: 'FAILED',
      CANCELED: 'CANCELED',
    };
    const refund = cents(r.amount?.summary?.refunded ?? 0);
    if (!map[r.status]) throw new BadRequestException('GATEWAY_UNKNOWN_STATUS');
    const status = refund > 0 ? 'REFUNDED' : map[r.status];
    if (!status) throw new BadRequestException('GATEWAY_UNKNOWN_STATUS');
    return {
      environment: c.environment,
      eventId: eventId(id(r.id), status, refund),
      type: 'charge',
      externalPaymentId: id(r.id),
      externalReference: r.reference_id,
      status,
      amountCents: cents(r.amount?.value),
      currency: r.amount?.currency,
      refundedAmountCents: refund,
    };
  }
  async getRefund(
    externalId: string,
    c: GatewayContext,
  ): Promise<VerifiedEvent> {
    const r = await this.recurringApi(c, `/refunds/${id(externalId)}`);
    if (r.id !== externalId)
      throw new BadRequestException('GATEWAY_REFERENCE_MISMATCH');
    if (r.status !== 'SUCCESS')
      throw new BadRequestException('REFUND_NOT_CONFIRMED');
    const payment = await this.recurringApi(
      c,
      `/payments/${id(r.payment?.id)}`,
    );
    if (payment.id !== r.payment?.id)
      throw new BadRequestException('GATEWAY_REFERENCE_MISMATCH');
    const invoice = await this.getPayment(id(payment.invoice?.id), c);
    if (r.amount?.currency !== invoice.currency)
      throw new BadRequestException('GATEWAY_CURRENCY_MISMATCH');
    return {
      ...invoice,
      status: 'REFUNDED',
      eventId: `refund:${id(r.id)}`,
      externalRefundId: id(r.id),
      refundIsDelta: true,
      refundedAmountCents: cents(r.amount?.value),
    };
  }
  async reconcile(
    i: {
      paymentId: string;
      externalPaymentId: string | null;
      externalCheckoutId: string | null;
      externalSubscriptionId?: string | null;
    },
    c: GatewayContext,
  ): Promise<ProviderEvent[]> {
    if (i.externalSubscriptionId) {
      // Public OpenAPI response is {}. Do not guess the envelope or offset semantics.
      await this.recurringApi(
        c,
        `/subscriptions/${id(i.externalSubscriptionId)}/invoices?limit=100&offset=0`,
      );
      throw new ServiceUnavailableException(
        'PAGBANK_INVOICES_CONTRACT_UNVERIFIED',
      );
    }
    if (i.externalPaymentId) {
      const payment = await this.getPayment(i.externalPaymentId, c);
      if (payment.externalReference !== i.paymentId)
        throw new BadRequestException('GATEWAY_REFERENCE_MISMATCH');
      return [payment];
    }
    if (!i.externalCheckoutId)
      throw new ServiceUnavailableException('GATEWAY_REFERENCE_REQUIRED');
    await this.api(
      c,
      `/checkouts/${id(i.externalCheckoutId)}?limit=100&offset=0`,
    );
    // Even a plausible payments[] is not a documented financial relationship.
    throw new ServiceUnavailableException(
      'PAGBANK_CHECKOUT_CONTRACT_UNVERIFIED',
    );
  }
  async verifyWebhook(
    raw: Buffer,
    headers: Headers,
    c: GatewayContext,
  ): Promise<ProviderEvent[]> {
    if (!Buffer.isBuffer(raw))
      throw new UnauthorizedException('WEBHOOK_INVALID_BODY');
    // Express captures rawBody after optional decompression. Reject encoded
    // requests so only untouched entity bytes can reach either verifier.
    if (
      headers['content-encoding'] !== undefined &&
      headers['content-encoding'] !== 'identity'
    )
      throw new UnauthorizedException('WEBHOOK_INVALID_BODY');
    const supplied = headers['x-payload-signature'];
    const values = (Array.isArray(supplied) ? supplied : [supplied ?? ''])
      .flatMap((v) => v.split(','))
      .map((v) => v.trim())
      .filter(Boolean);
    const reject = (reason: string): never => {
      // Public diagnostics contain no signature, body, key, token or reference.
      this.logger.warn({
        event: 'PAGBANK_WEBHOOK_REJECTED',
        environment: c.environment,
        reason,
      });
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'WEBHOOK_INVALID_SIGNATURE',
        reason,
      });
    };
    // Header presence selects the contract, including empty/malformed ECDSA.
    // Never downgrade to the shared-token contract after ECDSA failure.
    if (Object.hasOwn(headers, 'x-payload-signature')) {
      if (!values.length) reject('SIGNATURE_MISSING');
      if (values.length > 16) reject('SIGNATURE_LIMIT');
      const signatures = values
        .map((v) => this.base64(v, true))
        .filter((v): v is Buffer => v !== null);
      if (!signatures.length) reject('SIGNATURE_ENCODING_INVALID');
      const matches = (key: KeyObject) =>
        signatures
          .map((signature) => {
            try {
              return verify('sha256', raw, key, signature);
            } catch {
              return false;
            }
          })
          .some(Boolean);
      let key = await this.webhookKey(c);
      if (!matches(key)) {
        key = await this.webhookKey(c, true);
        if (!matches(key)) reject('SIGNATURE_MISMATCH');
      }
    } else {
      const authenticity = headers['x-authenticity-token'];
      if (!Object.hasOwn(headers, 'x-authenticity-token'))
        reject('SIGNATURE_MISSING');
      // Official account-token contract: lowercase hexadecimal SHA-256,
      // exactly one value, UTF-8 account token + ASCII hyphen + original bytes.
      if (
        typeof authenticity !== 'string' ||
        !/^[0-9a-f]{64}$/.test(authenticity)
      )
        reject('AUTHENTICITY_ENCODING_INVALID');
      if (!c.credentials)
        throw new ServiceUnavailableException(
          'PAGBANK_CREDENTIALS_UNAVAILABLE',
        );
      const expected = createHash('sha256')
        .update(c.credentials, 'utf8')
        .update('-')
        .update(raw)
        .digest();
      if (
        !timingSafeEqual(expected, Buffer.from(authenticity as string, 'hex'))
      )
        reject('AUTHENTICITY_MISMATCH');
    }
    {
      const e = json(raw),
        digest = createHash('sha256').update(raw).digest('hex');
      if (typeof e.event === 'string' && e.event.startsWith('subscription.')) {
        const subId = id(e.resource?.id);
        const events = await this.reconcile(
          {
            paymentId: '',
            externalPaymentId: null,
            externalCheckoutId: null,
            externalSubscriptionId: subId,
          },
          c,
        );
        return events.map((v, n) => ({
          ...v,
          eventId: `${digest}:${n}`,
          type: e.event,
        }));
      }
      if (e.event === 'refund.created')
        return [await this.getRefund(id(e.resource?.id), c)];
    }
    const e = json(raw);
    if (String(e.id).startsWith('CHEC_')) return []; // checkout lifecycle is not a financial confirmation
    let events: VerifiedEvent[];
    if (String(e.id).startsWith('ORDE_')) {
      const order = await this.api(c, `/orders/${id(e.id)}`);
      if (
        order.id !== e.id ||
        typeof order.reference_id !== 'string' ||
        !Array.isArray(order.charges)
      )
        throw new BadRequestException('GATEWAY_REFERENCE_MISMATCH');
      events = [];
      for (const charge of order.charges)
        events.push({
          ...(await this.getPayment(id(charge.id), c)),
          externalReference: order.reference_id,
        });
    } else events = [await this.getPayment(id(e.id), c)];
    const digest = createHash('sha256').update(raw).digest('hex');
    return events.map((v) => ({
      ...v,
      eventId: `${digest}:${v.externalPaymentId}`,
    }));
  }
}
