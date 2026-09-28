import { Injectable, BadRequestException } from '@nestjs/common';
import { StripeAdapter } from './adapters/stripe.adapter.js';
import { MercadoPagoAdapter } from './adapters/mercado-pago.adapter.js';
import { PagBankAdapter } from './adapters/pagbank.adapter.js';
import { AsaasAdapter } from './adapters/asaas.adapter.js';
import type { Gateway, GatewayProvider } from './gateway.types.js';
export type {
  Gateway,
  GatewayContext,
  ChargeInput,
  VerifiedEvent,
  GatewayProvider,
} from './gateway.types.js';
export const gateways = ['MERCADO_PAGO', 'STRIPE', 'PAGBANK', 'ASAAS'] as const;
export function gatewayName(value: string): Gateway {
  if (!gateways.includes(value as Gateway))
    throw new BadRequestException('Gateway inválido.');
  return value as Gateway;
}
@Injectable()
export class GatewayRegistry {
  private readonly providers: Record<Gateway, GatewayProvider> = {
    MERCADO_PAGO: new MercadoPagoAdapter(),
    STRIPE: new StripeAdapter(),
    PAGBANK: new PagBankAdapter(),
    ASAAS: new AsaasAdapter(),
  };
  get(gateway: Gateway): GatewayProvider {
    return this.providers[gateway];
  }
}
