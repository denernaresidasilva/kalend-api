export type Gateway = 'MERCADO_PAGO' | 'STRIPE' | 'PAGBANK' | 'ASAAS';
export type Environment = 'SANDBOX' | 'PRODUCTION';
export type Headers = Record<string, string | string[] | undefined>;
export interface GatewayContext {
  configurationVersion?: Date;
  environment: Environment;
  credentials: string;
  webhookSecret?: string;
  recurringCredentials?: string;
  recurringEnabled?: boolean;
}
export interface ChargeInput {
  paymentId: string;
  companyId: string;
  subscriptionId: string;
  planId: string;
  amountCents: number;
  currency: string;
  idempotencyKey: string;
  billingInterval: 'MONTHLY' | 'YEARLY';
  name: string;
  payerName?: string;
  email: string;
  taxId?: string;
  dueDate: string;
}
export interface ChargeResult {
  externalPaymentId?: string;
  externalCheckoutId?: string;
  externalSubscriptionId?: string;
  checkoutUrl?: string;
}
export interface VerifiedEvent {
  environment: Environment;
  eventId: string;
  type: string;
  externalPaymentId: string;
  externalReference?: string;
  externalSubscriptionId?: string;
  companyId?: string;
  planId?: string;
  status:
    'PENDING' | 'APPROVED' | 'FAILED' | 'OVERDUE' | 'REFUNDED' | 'CANCELED';
  amountCents: number;
  currency: string;
  refundedAmountCents?: number;
  externalRefundId?: string;
  refundIsDelta?: boolean;
  cycle?: number;
  periodStart?: string;
  periodEnd?: string;
}
export interface SubscriptionEvent {
  kind: 'subscription';
  environment: Environment;
  eventId: string;
  type: string;
  externalSubscriptionId: string;
  externalReference?: string;
  status: 'PENDING' | 'ACTIVE' | 'PAST_DUE' | 'CANCELED' | 'SUSPENDED';
  cancelAtPeriodEnd?: boolean;
}
export type ProviderEvent = VerifiedEvent | SubscriptionEvent;
export interface GatewayProvider {
  readonly capabilities: {
    checkout: boolean;
    recurring: boolean;
    nativeIdempotency: boolean;
    cancelAtPeriodEnd: boolean;
    webhookManagement: boolean;
    limitation?: string;
  };
  test(context: GatewayContext): Promise<void | Record<string, string>>;
  createCharge(
    input: ChargeInput,
    context: GatewayContext,
  ): Promise<ChargeResult>;
  getPayment(
    externalId: string,
    context: GatewayContext,
  ): Promise<VerifiedEvent>;
  reconcile(
    input: {
      paymentId: string;
      externalPaymentId: string | null;
      externalCheckoutId: string | null;
      externalSubscriptionId?: string | null;
    },
    context: GatewayContext,
  ): Promise<ProviderEvent[]>;
  createSubscription?(
    input: ChargeInput,
    context: GatewayContext,
  ): Promise<ChargeResult>;
  getRefund?(
    externalId: string,
    context: GatewayContext,
  ): Promise<VerifiedEvent>;
  getSubscription?(
    externalId: string,
    context: GatewayContext,
  ): Promise<SubscriptionEvent>;
  cancelSubscription?(
    externalId: string,
    context: GatewayContext,
    atPeriodEnd: boolean,
  ): Promise<void>;
  verifyWebhook(
    raw: Buffer,
    headers: Headers,
    context: GatewayContext,
    query?: Record<string, unknown>,
  ): Promise<ProviderEvent[]>;
}
