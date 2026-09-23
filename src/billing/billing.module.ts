import { Inject } from '@nestjs/common';
import { LifecycleService } from './lifecycle.service.js';
import {
  Body,
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
  @Post(':gateway/test') test(@Param('gateway') gateway: string) {
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
  ) {}
  @Post('mercado-pago') mercadoPago(@Req() req: RawBodyRequest<Request>) {
    return this.service.receive('MERCADO_PAGO', req.rawBody, req.headers);
  }
  @Post('stripe') stripe(@Req() req: RawBodyRequest<Request>) {
    return this.service.receive('STRIPE', req.rawBody, req.headers);
  }
  @Post('pagbank') pagbank(@Req() req: RawBodyRequest<Request>) {
    return this.service.receive('PAGBANK', req.rawBody, req.headers);
  }
  @Post(':id/reprocess')
  @UseGuards(AdminGuard)
  reprocess(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.reprocess(id);
  }
}
@Module({
  controllers: [
    LifecycleController,
    GatewaysController,
    PaymentsController,
    WebhookReceiverController,
  ],
  providers: [
    LifecycleService,
    GatewaysService,
    GatewayRegistry,
    SecretVault,
    PaymentsService,
    WebhookProcessor,
  ],
})
export class BillingModule {}
