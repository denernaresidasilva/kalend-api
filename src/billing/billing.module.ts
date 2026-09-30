import { AuthRateLimit } from '../auth/auth-rate-limit.service.js';
import { ProductAccessGuard } from './product-access.guard.js';
import {
  TenantGuard,
  TenantRoles,
  BillingRecovery,
} from '../auth/tenant.guard.js';
import type { AuthRequest } from '../auth/auth.types.js';
import { PlansService } from '../plans/plans.service.js';
import { RegularizationService } from './regularization.service.js';
import { EntitlementsService } from './entitlements.service.js';
import { Inject } from '@nestjs/common';
import { LifecycleService } from './lifecycle.service.js';
import {
  Body,
  HttpCode,
  Controller,
  Get,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { AdminGuard } from '../common/admin.guard.js';
import { GatewaysService } from './gateways.service.js';
import { GatewayRegistry } from './gateway.provider.js';
import { SecretVault } from './secret-vault.js';
import { PaymentsService } from './payments.service.js';
import { WebhookProcessor } from './webhook-processor.service.js';
@Controller('payment-gateways')
@UseGuards(AdminGuard)
export class GatewaysController {
  constructor(
    @Inject(GatewaysService) private readonly service: GatewaysService,
    @Inject(AuthRateLimit) private readonly limit: AuthRateLimit,
  ) {}
  @Get() list() {
    return this.service.list();
  }
  @Get(':gateway') get(@Param('gateway') gateway: string) {
    return this.service.get(gateway);
  }
  @Patch(':gateway') update(
    @Param('gateway') gateway: string,
    @Body() body: unknown,
  ) {
    return this.service.update(gateway, body);
  }
  @Post(':gateway/test') async test(
    @Param('gateway') gateway: string,
    @Req() req: AuthRequest,
  ) {
    await this.limit.consume('gateway-test', req.auth.user.id, 5, 300);
    await this.limit.consume('gateway-test-global', 'GLOBAL', 20, 300);
    return this.service.test(gateway);
  }
}
@Controller('billing')
@UseGuards(AdminGuard)
export class LifecycleController {
  constructor(
    @Inject(LifecycleService) private readonly service: LifecycleService,
  ) {}
  @Post('reconcile') reconcile() {
    return this.service.reconcile();
  }
}
@Controller('payments')
@UseGuards(AdminGuard)
export class PaymentsController {
  constructor(
    @Inject(PaymentsService) private readonly service: PaymentsService,
  ) {}
  @Post() create(@Body() body: unknown) {
    return this.service.create(body);
  }
}
@Controller('webhooks')
export class WebhookReceiverController {
  constructor(
    @Inject(WebhookProcessor) private readonly service: WebhookProcessor,
    @Inject(AuthRateLimit) private readonly limit: AuthRateLimit,
  ) {}
  @HttpCode(200)
  @Post('mercado-pago')
  mercadoPago(@Req() req: RawBodyRequest<Request>) {
    return this.service.receive(
      'MERCADO_PAGO',
      req.rawBody,
      req.headers,
      req.query,
    );
  }
  @HttpCode(200)
  @Post('stripe')
  stripe(@Req() req: RawBodyRequest<Request>) {
    return this.service.receive('STRIPE', req.rawBody, req.headers);
  }
  @HttpCode(200)
  @Post('pagbank')
  pagbank(@Req() req: RawBodyRequest<Request>) {
    return this.service.receive('PAGBANK', req.rawBody, req.headers);
  }
  @HttpCode(200)
  @Post('asaas')
  asaas(@Req() req: RawBodyRequest<Request>) {
    return this.service.receive('ASAAS', req.rawBody, req.headers);
  }
  @Post(':id/reprocess')
  @UseGuards(AdminGuard)
  async reprocess(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: AuthRequest,
  ) {
    await this.limit.consume('webhook-reprocess', req.auth.user.id, 10, 300);
    return this.service.reprocess(id);
  }
}
@Controller('billing')
@UseGuards(TenantGuard)
@TenantRoles('OWNER', 'ADMIN')
@BillingRecovery()
export class CommercialController {
  constructor(
    @Inject(RegularizationService)
    private readonly regularization: RegularizationService,
    @Inject(PaymentsService) private readonly payments: PaymentsService,
  ) {}
  @Get('regularization') get(@Req() req: AuthRequest) {
    return this.regularization.get(req.tenant!.companyId);
  }
  @Get('payments/:id') status(
    @Req() req: AuthRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.payments.status(req.tenant!.companyId, id);
  }
  @Post('checkout') checkout(@Req() req: AuthRequest, @Body() body: unknown) {
    return this.payments.checkout(req.tenant!.companyId, body);
  }
  @Post('subscriptions/:id/cancel') cancel(
    @Req() req: AuthRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ) {
    return this.regularization.cancel(req.tenant!.companyId, id, body);
  }
}
@Module({
  controllers: [
    CommercialController,
    LifecycleController,
    GatewaysController,
    PaymentsController,
    WebhookReceiverController,
  ],
  exports: [EntitlementsService, ProductAccessGuard],
  providers: [
    AuthRateLimit,
    EntitlementsService,
    ProductAccessGuard,
    RegularizationService,
    PlansService,
    LifecycleService,
    GatewaysService,
    GatewayRegistry,
    SecretVault,
    PaymentsService,
    WebhookProcessor,
  ],
})
export class BillingModule {}
