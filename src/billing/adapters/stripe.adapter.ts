import { createHmac } from 'node:crypto';
import {
  BadRequestException,
  ServiceUnavailableException,
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
  cents,
  checkoutUrl,
  equalSecret,
  eventId,
  fresh,
  header,
  id,
  json,
  live,
  request,
  returnUrl,
} from './http.js';
import type { Remote } from './http.js';
export class StripeAdapter implements GatewayProvider {
  readonly capabilities = {
    checkout: true,
    recurring: true,
    nativeIdempotency: true,
    cancelAtPeriodEnd: true,
    webhookManagement: false,
  };
  private api(
    c: GatewayContext,
    path: string,
    method = 'GET',
    body?: URLSearchParams,
    key?: string,
  ) {
    if (
      !new RegExp(
        `^(sk|rk)_${c.environment === 'SANDBOX' ? 'test' : 'live'}_`,
      ).test(c.credentials)
    )
      throw new BadRequestException('GATEWAY_ENVIRONMENT_MISMATCH');
    return request(
      `https://api.stripe.com/v1${path}`,
      {
        Authorization: `Bearer ${c.credentials}`,
        'Stripe-Version': '2025-06-30.basil',
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      method,
      body,
    );
  }
  async test(c: GatewayContext) {
    const r = await this.api(c, '/balance');
    live(r.livemode, c);
  }
  private async checkout(
    i: ChargeInput,
    c: GatewayContext,
    recurring: boolean,
  ) {
    const p = new URLSearchParams({
      mode: recurring ? 'subscription' : 'payment',
      success_url: returnUrl(),
      cancel_url: returnUrl(),
      client_reference_id: i.paymentId,
      customer_email: i.email,
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': i.currency.toLowerCase(),
      'line_items[0][price_data][unit_amount]': String(i.amountCents),
      'line_items[0][price_data][product_data][name]': i.name,
    });
    const metadata = {
      paymentId: i.paymentId,
      companyId: i.companyId,
      planId: i.planId,
      subscriptionId: i.subscriptionId,
    };
    for (const [k, v] of Object.entries(metadata)) {
      p.set(`metadata[${k}]`, v);
      p.set(
        `${recurring ? 'subscription_data' : 'payment_intent_data'}[metadata][${k}]`,
        v,
      );
    }
    if (recurring)
      p.set(
        'line_items[0][price_data][recurring][interval]',
        i.billingInterval === 'YEARLY' ? 'year' : 'month',
      );
    const r = await this.api(
      c,
      '/checkout/sessions',
      'POST',
      p,
      i.idempotencyKey,
    );
    live(r.livemode, c);
    return {
      externalCheckoutId: id(r.id),
      checkoutUrl: checkoutUrl(r.url, ['checkout.stripe.com']),
      externalSubscriptionId:
        typeof r.subscription === 'string' ? id(r.subscription) : undefined,
    };
  }
  createCharge(i: ChargeInput, c: GatewayContext) {
    return this.checkout(i, c, false);
  }
  createSubscription(i: ChargeInput, c: GatewayContext) {
    return this.checkout(i, c, true);
  }
  async getPayment(
    externalId: string,
    c: GatewayContext,
  ): Promise<VerifiedEvent> {
    const invoice = externalId.startsWith('in_');
    const r = await this.api(
      c,
      invoice
        ? `/invoices/${id(externalId)}`
        : `/payment_intents/${id(externalId)}?expand[]=latest_charge`,
    );
    live(r.livemode, c);
    const meta = invoice
      ? (r.parent?.subscription_details?.metadata ??
        r.subscription_details?.metadata ??
        {})
      : (r.metadata ?? {});
    const sub = invoice
      ? (r.parent?.subscription_details?.subscription ?? r.subscription)
      : undefined;
    const charge =
      !invoice && typeof r.latest_charge === 'object'
        ? r.latest_charge
        : undefined;
    let refunded = charge?.amount_refunded ? cents(charge.amount_refunded) : 0;
    if (invoice && r.status === 'paid') {
      const payments = await this.api(
        c,
        `/invoice_payments?invoice=${id(r.id)}&status=paid&limit=100`,
      );
      if (payments.has_more)
        throw new ServiceUnavailableException(
          'RECONCILIATION_PAGINATION_REQUIRED',
        );
      for (const payment of payments.data ?? []) {
        live(payment.livemode, c);
        if (payment.payment?.type === 'payment_intent') {
          const intent = await this.getPayment(
            id(payment.payment.payment_intent),
            c,
          );
          refunded += intent.refundedAmountCents ?? 0;
        }
      }
    }
    const status =
      refunded > 0
        ? 'REFUNDED'
        : invoice
          ? r.status === 'paid'
            ? 'APPROVED'
            : r.status === 'void'
              ? 'CANCELED'
              : r.status === 'uncollectible'
                ? 'FAILED'
                : r.attempted && r.attempt_count > 0
                  ? 'OVERDUE'
                  : 'PENDING'
          : r.status === 'succeeded'
            ? 'APPROVED'
            : r.status === 'canceled'
              ? 'CANCELED'
              : r.last_payment_error
                ? 'FAILED'
                : 'PENDING';
    const period =
      invoice && r.lines?.data?.length === 1
        ? r.lines.data[0].period
        : undefined;
    return {
      environment: c.environment,
      eventId: eventId(id(r.id), status, refunded),
      type: invoice ? 'invoice' : 'payment_intent',
      externalPaymentId: id(r.id),
      externalReference: meta.paymentId,
      externalSubscriptionId: sub ? id(sub) : undefined,
      companyId: meta.companyId,
      planId: meta.planId,
      status,
      amountCents: cents(invoice ? r.total : r.amount),
      currency: String(r.currency).toUpperCase(),
      refundedAmountCents: refunded,
      periodStart: period
        ? new Date(period.start * 1000).toISOString()
        : undefined,
      periodEnd: period ? new Date(period.end * 1000).toISOString() : undefined,
    };
  }
  async getSubscription(
    externalId: string,
    c: GatewayContext,
  ): Promise<SubscriptionEvent> {
    const r = await this.api(c, `/subscriptions/${id(externalId)}`);
    live(r.livemode, c);
    const status =
      r.status === 'canceled'
        ? 'CANCELED'
        : ['past_due', 'unpaid'].includes(r.status)
          ? 'PAST_DUE'
          : r.status === 'paused'
            ? 'SUSPENDED'
            : r.status === 'active'
              ? 'ACTIVE'
              : 'PENDING';
    return {
      kind: 'subscription',
      environment: c.environment,
      eventId: eventId(id(r.id), `${status}:${!!r.cancel_at_period_end}`),
      type: 'subscription',
      externalSubscriptionId: id(r.id),
      externalReference: r.metadata?.subscriptionId,
      status,
      cancelAtPeriodEnd: !!r.cancel_at_period_end,
    };
  }
  async cancelSubscription(
    externalId: string,
    c: GatewayContext,
    atPeriodEnd: boolean,
  ) {
    await this.api(
      c,
      `/subscriptions/${id(externalId)}`,
      atPeriodEnd ? 'POST' : 'DELETE',
      atPeriodEnd
        ? new URLSearchParams({ cancel_at_period_end: 'true' })
        : undefined,
      `cancel:${externalId}:${atPeriodEnd}`,
    );
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
    if (i.externalPaymentId)
      return [await this.getPayment(i.externalPaymentId, c)];
    let subscriptionId = i.externalSubscriptionId;
    let r: Remote = {};
    if (i.externalCheckoutId) {
      r = await this.api(c, `/checkout/sessions/${id(i.externalCheckoutId)}`);
      live(r.livemode, c);
      if (r.client_reference_id !== i.paymentId)
        throw new BadRequestException('GATEWAY_REFERENCE_MISMATCH');
      subscriptionId = r.subscription ?? subscriptionId;
    } else if (!subscriptionId)
      throw new ServiceUnavailableException('GATEWAY_REFERENCE_REQUIRED');
    if (subscriptionId) {
      const invoices = await this.api(
        c,
        `/invoices?subscription=${id(subscriptionId)}&limit=100`,
      );
      if (invoices.has_more)
        throw new ServiceUnavailableException(
          'RECONCILIATION_PAGINATION_REQUIRED',
        );
      const events: ProviderEvent[] = [
        await this.getSubscription(id(subscriptionId), c),
      ];
      for (const inv of invoices.data ?? [])
        events.push(await this.getPayment(id(inv.id), c));
      return events;
    }
    return r.payment_intent
      ? [await this.getPayment(id(r.payment_intent), c)]
      : [];
  }
  async verifyWebhook(
    raw: Buffer,
    headers: Headers,
    c: GatewayContext,
  ): Promise<ProviderEvent[]> {
    const parts = header(headers, 'stripe-signature')
      .split(',')
      .map((p) => p.split('='));
    const ts = parts.find(([k]) => k === 't')?.[1] ?? '';
    fresh(ts);
    if (!c.webhookSecret)
      throw new ServiceUnavailableException('WEBHOOK_NOT_CONFIGURED');
    const expected = createHmac('sha256', c.webhookSecret)
      .update(`${ts}.`)
      .update(raw)
      .digest('hex');
    if (
      !parts.some(([k, v]) => {
        if (k !== 'v1') return false;
        try {
          equalSecret(v, expected);
          return true;
        } catch {
          return false;
        }
      })
    )
      equalSecret('', expected);
    const e = json(raw);
    live(e.livemode, c);
    id(e.id);
    const obj: Remote = e.data?.object ?? {};
    let events: ProviderEvent[] = [];
    if (
      [
        'checkout.session.completed',
        'checkout.session.async_payment_succeeded',
        'checkout.session.async_payment_failed',
      ].includes(e.type)
    )
      events = await this.reconcile(
        {
          paymentId: obj.client_reference_id,
          externalPaymentId: null,
          externalCheckoutId: id(obj.id),
        },
        c,
      );
    else if (
      [
        'invoice.paid',
        'invoice.payment_failed',
        'invoice.voided',
        'invoice.marked_uncollectible',
      ].includes(e.type)
    )
      events = [await this.getPayment(id(obj.id), c)];
    else if (
      [
        'payment_intent.succeeded',
        'payment_intent.payment_failed',
        'payment_intent.canceled',
      ].includes(e.type)
    )
      events = [await this.getPayment(id(obj.id), c)];
    else if (e.type === 'charge.refunded' && obj.payment_intent) {
      const related = obj.invoice
        ? [{ invoice: obj.invoice }]
        : ((
            await this.api(
              c,
              `/invoice_payments?payment[type]=payment_intent&payment[payment_intent]=${id(obj.payment_intent)}&limit=100`,
            )
          ).data ?? []);
      if (related.length > 1)
        throw new BadRequestException('AMBIGUOUS_INVOICE_REFUND');
      events = [
        await this.getPayment(
          related.length ? id(related[0].invoice) : id(obj.payment_intent),
          c,
        ),
      ];
    } else if (
      [
        'customer.subscription.created',
        'customer.subscription.updated',
        'customer.subscription.deleted',
        'customer.subscription.paused',
        'customer.subscription.resumed',
      ].includes(e.type)
    )
      events = [await this.getSubscription(id(obj.id), c)];
    return events.map((v, n) => ({
      ...v,
      eventId: `${e.id}:${n}:${'kind' in v ? v.externalSubscriptionId : v.externalPaymentId}`,
      type: e.type,
    }));
  }
}
