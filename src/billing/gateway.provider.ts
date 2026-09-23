import {
  Injectable,
  ServiceUnavailableException,
  BadRequestException,
} from '@nestjs/common';
export const gateways = ['MERCADO_PAGO', 'STRIPE', 'PAGBANK'] as const;
export type Gateway = (typeof gateways)[number];
export function gatewayName(value: string): Gateway {
  if (!gateways.includes(value as Gateway))
    throw new BadRequestException('Gateway inválido.');
  return value as Gateway;
}
export interface GatewayContext {
  environment: 'SANDBOX' | 'PRODUCTION';
  credentials: string;
  webhookSecret?: string;
}
export interface ChargeInput {
  paymentId: string;
  companyId: string;
  subscriptionId: string;
  planId: string;
  amountCents: number;
  currency: string;
  idempotencyKey: string;
}
/** Only normalized, authenticated data returned by an official provider adapter. Never an HTTP DTO. */
export interface VerifiedEvent {
  environment: 'SANDBOX' | 'PRODUCTION';
  eventId: string;
  type: string;
  externalPaymentId: string;
  status: 'APPROVED' | 'FAILED' | 'REFUNDED' | 'CANCELED';
  amountCents: number;
  currency: string;
}
export interface GatewayProvider {
  test(context: GatewayContext): Promise<void>;
  createCharge(
    input: ChargeInput,
    context: GatewayContext,
  ): Promise<{ externalPaymentId: string }>;
  getPayment(
    externalId: string,
    context: GatewayContext,
  ): Promise<VerifiedEvent>;
  createSubscription(
    input: ChargeInput,
    context: GatewayContext,
  ): Promise<{ externalSubscriptionId: string }>;
  cancelSubscription(
    externalId: string,
    context: GatewayContext,
  ): Promise<void>;
  verifyWebhook(
    raw: Buffer,
    headers: Record<string, string | string[] | undefined>,
    context: GatewayContext,
  ): Promise<VerifiedEvent>;
}
@Injectable()
export class GatewayRegistry {
  // No network adapters registered until official signature verification and sandbox tests exist.
  get(_gateway: Gateway): GatewayProvider {
    throw new ServiceUnavailableException('GATEWAY_ADAPTER_PENDING');
  }
}
