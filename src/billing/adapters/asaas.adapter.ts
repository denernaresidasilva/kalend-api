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
  header,
  id,
  json,
  request,
} from './http.js';
import type { Remote } from './http.js';
export class AsaasAdapter implements GatewayProvider {
  readonly capabilities = {
    checkout: true,
    recurring: true,
    nativeIdempotency: false,
    cancelAtPeriodEnd: false,
    webhookManagement: true,
  };
  private api(c: GatewayContext, path: string, method = 'GET', body?: Remote) {
    return request(
      `https://${c.environment === 'SANDBOX' ? 'api-sandbox' : 'api'}.asaas.com/v3${path}`,
      { access_token: c.credentials },
      method,
      body,
    );
  }
  async test(c: GatewayContext) {
    await this.api(c, '/finance/balance');
  }
  private async customer(i: ChargeInput, c: GatewayContext) {
    if (!i.taxId || !/^\d{11}(\d{3})?$/.test(i.taxId))
      throw new BadRequestException('BILLING_TAX_ID_REQUIRED');
    const found = await this.api(
      c,
      `/customers?externalReference=${id(i.companyId)}&limit=100`,
    );
    if (found.hasMore || found.data?.length > 1)
      throw new BadRequestException('GATEWAY_AMBIGUOUS_CUSTOMER');
    if (found.data?.length === 1) return id(found.data[0].id);
    const r = await this.api(c, '/customers', 'POST', {
      name: i.payerName ?? i.name,
      cpfCnpj: i.taxId,
      email: i.email,
      externalReference: i.companyId,
      notificationDisabled: true,
    });
    return id(r.id);
  }
  async createCharge(i: ChargeInput, c: GatewayContext) {
    const r = await this.api(c, '/payments', 'POST', {
      customer: await this.customer(i, c),
      billingType: 'UNDEFINED',
      value: i.amountCents / 100,
      dueDate: i.dueDate,
      externalReference: i.paymentId,
      description: i.name,
      discount: { value: 0 },
      interest: { value: 0 },
      fine: { value: 0 },
    });
    return {
      externalPaymentId: id(r.id),
      checkoutUrl: checkoutUrl(r.invoiceUrl, ['asaas.com']),
    };
  }
  async createSubscription(i: ChargeInput, c: GatewayContext) {
    const r = await this.api(c, '/subscriptions', 'POST', {
      customer: await this.customer(i, c),
      billingType: 'UNDEFINED',
      value: i.amountCents / 100,
      nextDueDate: i.dueDate,
      cycle: i.billingInterval,
      externalReference: i.subscriptionId,
      description: i.name,
      discount: { value: 0 },
      interest: { value: 0 },
      fine: { value: 0 },
    });
    const payments = await this.api(
      c,
      `/payments?subscription=${id(r.id)}&limit=100`,
    );
    const first = payments.data?.[0];
    return {
      externalSubscriptionId: id(r.id),
      externalPaymentId: first ? id(first.id) : undefined,
      checkoutUrl: checkoutUrl(first?.invoiceUrl, ['asaas.com']),
    };
  }
  async getPayment(
    externalId: string,
    c: GatewayContext,
  ): Promise<VerifiedEvent> {
    const r = await this.api(c, `/payments/${id(externalId)}`);
    const map: Record<string, VerifiedEvent['status']> = {
      PENDING: 'PENDING',
      AWAITING_RISK_ANALYSIS: 'PENDING',
      RECEIVED: 'APPROVED',
      CONFIRMED: 'APPROVED',
      RECEIVED_IN_CASH: 'PENDING',
      OVERDUE: 'OVERDUE',
      REFUNDED: 'REFUNDED',
      REFUND_REQUESTED: 'PENDING',
      REFUND_IN_PROGRESS: 'PENDING',
      CHARGEBACK_REQUESTED: 'FAILED',
      CHARGEBACK_DISPUTE: 'FAILED',
      AWAITING_CHARGEBACK_REVERSAL: 'FAILED',
      DUNNING_REQUESTED: 'OVERDUE',
      DUNNING_RECEIVED: 'APPROVED',
    };
    const status = r.deleted ? 'CANCELED' : map[r.status];
    if (!status) throw new BadRequestException('GATEWAY_UNKNOWN_STATUS');
    const refunded =
      status === 'REFUNDED'
        ? cents(r.value, true)
        : (r.refunds ?? [])
            .filter((x: Remote) => x.status === 'DONE')
            .reduce((n: number, x: Remote) => n + cents(x.value, true), 0);
    return {
      environment: c.environment,
      eventId: eventId(id(r.id), status, refunded),
      type: 'payment',
      externalPaymentId: id(r.id),
      externalReference: r.externalReference,
      externalSubscriptionId: r.subscription ? id(r.subscription) : undefined,
      status: refunded > 0 ? 'REFUNDED' : status,
      amountCents: cents(r.originalValue ?? r.value, true),
      currency: 'BRL',
      refundedAmountCents: refunded,
      periodStart:
        r.subscription && /^\d{4}-\d{2}-\d{2}$/.test(r.dueDate)
          ? `${r.dueDate}T00:00:00.000Z`
          : undefined,
    };
  }
  async getSubscription(
    externalId: string,
    c: GatewayContext,
  ): Promise<SubscriptionEvent> {
    const r = await this.api(c, `/subscriptions/${id(externalId)}`);
    const status = r.deleted
      ? 'CANCELED'
      : r.status === 'ACTIVE'
        ? 'ACTIVE'
        : 'SUSPENDED';
    return {
      kind: 'subscription',
      environment: c.environment,
      eventId: eventId(id(r.id), status),
      type: 'subscription',
      externalSubscriptionId: id(r.id),
      externalReference: r.externalReference,
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
    await this.api(c, `/subscriptions/${id(externalId)}`, 'DELETE');
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
    if (i.externalPaymentId && !i.externalSubscriptionId)
      return [await this.getPayment(i.externalPaymentId, c)];
    const filter = i.externalSubscriptionId
      ? `subscription=${id(i.externalSubscriptionId)}`
      : `externalReference=${id(i.paymentId)}`;
    const events: ProviderEvent[] = i.externalSubscriptionId
      ? [await this.getSubscription(i.externalSubscriptionId, c)]
      : [];
    for (let offset = 0; offset < 10000; offset += 100) {
      const r = await this.api(
        c,
        `/payments?${filter}&limit=100&offset=${offset}`,
      );
      for (const p of r.data ?? [])
        events.push(await this.getPayment(id(p.id), c));
      if (!r.hasMore) return events;
    }
    throw new ServiceUnavailableException('RECONCILIATION_PAGINATION_REQUIRED');
  }
  async verifyWebhook(
    raw: Buffer,
    headers: Headers,
    c: GatewayContext,
  ): Promise<ProviderEvent[]> {
    if (!c.webhookSecret || c.webhookSecret === c.credentials)
      throw new ServiceUnavailableException('WEBHOOK_SEPARATE_SECRET_REQUIRED');
    equalSecret(header(headers, 'asaas-access-token'), c.webhookSecret);
    const e = json(raw);
    id(e.id);
    let event: ProviderEvent;
    if (typeof e.event !== 'string')
      throw new BadRequestException('WEBHOOK_INVALID_BODY');
    if (e.event.startsWith('PAYMENT_') && e.payment?.id) {
      event = await this.getPayment(id(e.payment.id), c);
      if (
        e.event === 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED' &&
        event.status === 'PENDING'
      )
        event = { ...event, status: 'FAILED' };
    } else if (
      [
        'SUBSCRIPTION_CREATED',
        'SUBSCRIPTION_UPDATED',
        'SUBSCRIPTION_INACTIVATED',
        'SUBSCRIPTION_DELETED',
      ].includes(e.event) &&
      e.subscription?.id
    ) {
      if (e.event === 'SUBSCRIPTION_DELETED')
        event = {
          kind: 'subscription',
          environment: c.environment,
          eventId: e.id,
          type: e.event,
          externalSubscriptionId: id(e.subscription.id),
          externalReference: e.subscription.externalReference,
          status: 'CANCELED',
        };
      else event = await this.getSubscription(id(e.subscription.id), c);
    } else return [];
    return [{ ...event, eventId: e.id, type: e.event }];
  }
  // Backend-only capability: URL is controlled by deployment, authToken is separate from API key.
  async configureWebhook(c: GatewayContext, email: string) {
    if (!c.webhookSecret || c.webhookSecret === c.credentials)
      throw new BadRequestException('WEBHOOK_SEPARATE_SECRET_REQUIRED');
    const r = await this.api(c, '/webhooks', 'POST', {
      name: 'Kalend Billing',
      url: callback('/webhooks/asaas'),
      email,
      enabled: true,
      interrupted: false,
      apiVersion: 3,
      authToken: c.webhookSecret,
      sendType: 'SEQUENTIALLY',
      events: [
        'PAYMENT_CREATED',
        'PAYMENT_CONFIRMED',
        'PAYMENT_RECEIVED',
        'PAYMENT_OVERDUE',
        'PAYMENT_REFUNDED',
        'PAYMENT_DELETED',
        'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED',
        'SUBSCRIPTION_CREATED',
        'SUBSCRIPTION_UPDATED',
        'SUBSCRIPTION_INACTIVATED',
        'SUBSCRIPTION_DELETED',
      ],
    });
    return { id: id(r.id), configured: true };
  }
}
