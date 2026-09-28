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
  callback,
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
export class MercadoPagoAdapter implements GatewayProvider {
  readonly capabilities = {
    checkout: true,
    recurring: true,
    nativeIdempotency: false,
    cancelAtPeriodEnd: false,
    webhookManagement: false,
    limitation:
      'Recorrência exige conta de teste própria e notificações autenticadas; IPN não é aceito.',
  };
  private api(c: GatewayContext, path: string, method = 'GET', body?: Remote) {
    return request(
      `https://api.mercadopago.com${path}`,
      { Authorization: `Bearer ${c.credentials}` },
      method,
      body,
    );
  }
  async test(c: GatewayContext) {
    const r = await this.api(c, '/users/me');
    id(r.id);
    if (
      !Array.isArray(r.tags) ||
      r.tags.includes('test_user') !== (c.environment === 'SANDBOX')
    )
      throw new BadRequestException('GATEWAY_ENVIRONMENT_MISMATCH');
  }
  async createCharge(i: ChargeInput, c: GatewayContext) {
    const r = await this.api(c, '/checkout/preferences', 'POST', {
      external_reference: i.paymentId,
      items: [
        {
          id: i.planId,
          title: i.name,
          quantity: 1,
          currency_id: i.currency,
          unit_price: i.amountCents / 100,
        },
      ],
      payer: { email: i.email },
      notification_url: callback('/webhooks/mercado-pago'),
      back_urls: {
        success: returnUrl(),
        failure: returnUrl(),
        pending: returnUrl(),
      },
      metadata: { company_id: i.companyId, plan_id: i.planId },
    });
    return {
      externalCheckoutId: id(r.id),
      checkoutUrl: checkoutUrl(
        c.environment === 'SANDBOX' ? r.sandbox_init_point : r.init_point,
        ['mercadopago.com.br', 'mercadopago.com'],
      ),
    };
  }
  async createSubscription(i: ChargeInput, c: GatewayContext) {
    const r = await this.api(c, '/preapproval', 'POST', {
      reason: i.name,
      external_reference: i.subscriptionId,
      payer_email: i.email,
      auto_recurring: {
        frequency: i.billingInterval === 'YEARLY' ? 12 : 1,
        frequency_type: 'months',
        transaction_amount: i.amountCents / 100,
        currency_id: i.currency,
      },
      back_url: returnUrl(),
      status: 'pending',
    });
    return {
      externalSubscriptionId: id(r.id),
      checkoutUrl: checkoutUrl(r.init_point, [
        'mercadopago.com.br',
        'mercadopago.com',
      ]),
    };
  }
  async getPayment(
    externalId: string,
    c: GatewayContext,
  ): Promise<VerifiedEvent> {
    const r = await this.api(c, `/v1/payments/${id(externalId)}`);
    live(r.live_mode, c);
    const map: Record<string, VerifiedEvent['status']> = {
      pending: 'PENDING',
      in_process: 'PENDING',
      authorized: 'PENDING',
      approved: 'APPROVED',
      rejected: 'FAILED',
      cancelled: 'CANCELED',
      refunded: 'REFUNDED',
      charged_back: 'REFUNDED',
    };
    const status = map[r.status];
    if (!status) throw new BadRequestException('GATEWAY_UNKNOWN_STATUS');
    const refund =
      r.status === 'charged_back'
        ? cents(r.transaction_amount, true)
        : cents(r.transaction_amount_refunded ?? 0, true);
    return {
      environment: c.environment,
      eventId: eventId(id(r.id), status, refund),
      type: 'payment',
      externalPaymentId: id(r.id),
      externalReference: r.external_reference,
      externalSubscriptionId: r.metadata?.preapproval_id,
      companyId: r.metadata?.company_id,
      planId: r.metadata?.plan_id,
      status: refund > 0 ? 'REFUNDED' : status,
      amountCents: cents(r.transaction_amount, true),
      currency: r.currency_id,
      refundedAmountCents: refund,
    };
  }
  async getSubscription(
    externalId: string,
    c: GatewayContext,
  ): Promise<SubscriptionEvent> {
    const r = await this.api(c, `/preapproval/${id(externalId)}`);
    const status =
      r.status === 'cancelled'
        ? 'CANCELED'
        : r.status === 'paused'
          ? 'SUSPENDED'
          : r.status === 'authorized'
            ? 'ACTIVE'
            : 'PENDING';
    return {
      kind: 'subscription',
      environment: c.environment,
      eventId: eventId(id(r.id), status),
      type: 'subscription_preapproval',
      externalSubscriptionId: id(r.id),
      externalReference: r.external_reference,
      status,
    };
  }
  async cancelSubscription(
    externalId: string,
    c: GatewayContext,
    atPeriodEnd: boolean,
  ) {
    if (atPeriodEnd)
      throw new BadRequestException('GATEWAY_CAPABILITY_UNAVAILABLE');
    await this.api(c, `/preapproval/${id(externalId)}`, 'PUT', {
      status: 'cancelled',
    });
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
    if (i.externalSubscriptionId) {
      const r = await this.api(
        c,
        `/authorized_payments/search?preapproval_id=${id(i.externalSubscriptionId)}&limit=100`,
      );
      if (r.paging?.total > 100)
        throw new ServiceUnavailableException(
          'RECONCILIATION_PAGINATION_REQUIRED',
        );
      const events: ProviderEvent[] = [
        await this.getSubscription(i.externalSubscriptionId, c),
      ];
      for (const p of r.results ?? [])
        if (p.payment?.id)
          events.push({
            ...(await this.getPayment(id(p.payment.id), c)),
            externalSubscriptionId: i.externalSubscriptionId,
            periodStart: p.debit_date,
          });
      return events;
    }
    const r = await this.api(
      c,
      `/v1/payments/search?external_reference=${id(i.paymentId)}&limit=100`,
    );
    if (r.paging?.total > 100)
      throw new ServiceUnavailableException(
        'RECONCILIATION_PAGINATION_REQUIRED',
      );
    return Promise.all(
      (r.results ?? []).map((p: Remote) => this.getPayment(id(p.id), c)),
    );
  }
  async verifyWebhook(
    raw: Buffer,
    headers: Headers,
    c: GatewayContext,
    query: Record<string, unknown> = {},
  ): Promise<ProviderEvent[]> {
    if (!c.webhookSecret)
      throw new ServiceUnavailableException('WEBHOOK_NOT_CONFIGURED');
    const parts = Object.fromEntries(
      header(headers, 'x-signature')
        .split(',')
        .map((p) => p.trim().split('=')),
    );
    fresh(parts.ts ?? '');
    const resource = id(query['data.id']);
    const manifest = `id:${resource.toLowerCase()};request-id:${header(headers, 'x-request-id')};ts:${parts.ts};`;
    equalSecret(
      parts.v1 ?? '',
      createHmac('sha256', c.webhookSecret).update(manifest).digest('hex'),
    );
    const e = json(raw);
    live(e.live_mode, c);
    if (id(e.data?.id) !== resource)
      throw new BadRequestException('WEBHOOK_REFERENCE_MISMATCH');
    let event: ProviderEvent;
    if (e.type === 'payment') event = await this.getPayment(resource, c);
    else if (e.type === 'subscription_preapproval')
      event = await this.getSubscription(resource, c);
    else if (e.type === 'subscription_authorized_payment') {
      const r = await this.api(c, `/authorized_payments/${resource}`);
      if (!r.payment?.id) return [];
      event = {
        ...(await this.getPayment(id(r.payment.id), c)),
        externalSubscriptionId: id(r.preapproval_id),
        periodStart: r.debit_date,
      };
    } else return [];
    return [
      { ...event, eventId: `${id(e.id)}:${e.action ?? e.type}`, type: e.type },
    ];
  }
}
