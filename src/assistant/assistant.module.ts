import {
  Body,
  Controller,
  Get,
  Inject,
  Module,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { OperationsModule, operator } from '../operations/operations.module.js';
import { BookingsModule } from '../bookings/bookings.module.js';
import { TenantGuard, TenantRoles } from '../auth/tenant.guard.js';
import { ProductAccessGuard } from '../billing/product-access.guard.js';
import { AuthRateLimit } from '../auth/auth-rate-limit.service.js';
import type { AuthRequest } from '../auth/auth.types.js';
import { AssistantService } from './assistant.service.js';
import { AI_PROVIDER, UnconfiguredAiProvider } from './provider.js';
@Controller('assistant')
@UseGuards(TenantGuard, ProductAccessGuard)
export class AssistantController {
  constructor(
    @Inject(AssistantService) private readonly service: AssistantService,
    @Inject(AuthRateLimit) private readonly rate: AuthRateLimit,
  ) {}
  @Get('settings') @TenantRoles('OWNER', 'ADMIN') settings(
    @Req() r: AuthRequest,
  ) {
    return this.service.settings(operator(r));
  }
  @Post('settings') @TenantRoles('OWNER', 'ADMIN') configure(
    @Req() r: AuthRequest,
    @Body() b: unknown,
  ) {
    return this.service.settings(operator(r), b);
  }
  @Get('dashboard') @TenantRoles('OWNER', 'ADMIN') dashboard(
    @Req() r: AuthRequest,
  ) {
    return this.service.dashboard(operator(r));
  }
  @Post('tools') @TenantRoles('OWNER', 'ADMIN') async tools(
    @Req() r: AuthRequest,
    @Body() b: unknown,
  ) {
    await this.rate.consume('ai-tools', r.tenant!.companyId, 20, 60);
    return this.service.tools(operator(r), b);
  }
}
@Module({
  imports: [AuthModule, BillingModule, OperationsModule, BookingsModule],
  controllers: [AssistantController],
  providers: [
    AssistantService,
    { provide: AI_PROVIDER, useClass: UnconfiguredAiProvider },
  ],
})
export class AssistantModule {}
