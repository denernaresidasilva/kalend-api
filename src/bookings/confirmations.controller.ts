import { DepositPoliciesService } from './deposit-contract.js';
import { ReschedulingService } from './rescheduling.service.js';
import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthOriginGuard } from '../auth/auth.guard.js';
import { AuthRateLimit } from '../auth/auth-rate-limit.service.js';
import type { AuthRequest } from '../auth/auth.types.js';
import { TenantGuard, TenantRoles } from '../auth/tenant.guard.js';
import { ProductAccessGuard } from '../billing/product-access.guard.js';
import { operator } from '../operations/operations.module.js';
import { ConfirmationsService } from './confirmations.service.js';
@Controller('public/booking-confirmation')
@UseGuards(AuthOriginGuard)
export class PublicConfirmationsController {
  constructor(
    @Inject(ConfirmationsService)
    private readonly service: ConfirmationsService,
    @Inject(AuthRateLimit) private readonly limits: AuthRateLimit,
  ) {}
  @Post('view') async view(@Body() b: unknown, @Req() r: AuthRequest) {
    await this.limits.consume('confirmation-view', r.ip ?? 'unknown', 30, 300);
    return this.service.view(b);
  }
  @Post('respond') async respond(@Body() b: unknown, @Req() r: AuthRequest) {
    await this.limits.consume(
      'confirmation-respond',
      r.ip ?? 'unknown',
      10,
      300,
    );
    return this.service.respond(b);
  }
}
@Controller('booking/confirmations')
@UseGuards(TenantGuard, ProductAccessGuard)
export class TenantConfirmationsController {
  constructor(
    @Inject(ConfirmationsService)
    private readonly service: ConfirmationsService,
    @Inject(ReschedulingService)
    private readonly rescheduling: ReschedulingService,
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
  @Post('run-due') @TenantRoles('OWNER', 'ADMIN') due(@Req() r: AuthRequest) {
    return this.service.due([r.tenant!.companyId]);
  }
  @Get('customers/:id/history')
  @TenantRoles('OWNER', 'ADMIN', 'RECEPTIONIST')
  history(@Req() r: AuthRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.history(operator(r), id);
  }
  @Post('requests/:id/reschedule')
  @TenantRoles('OWNER', 'ADMIN', 'RECEPTIONIST')
  move(
    @Req() r: AuthRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() b: unknown,
  ) {
    return this.rescheduling.move(operator(r), id, b);
  }
  @Post('requests/:id/review')
  @TenantRoles('OWNER', 'ADMIN', 'RECEPTIONIST')
  review(
    @Req() r: AuthRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() b: unknown,
  ) {
    return this.service.review(operator(r), id, b);
  }
}

@Controller('booking/deposit-policies')
@UseGuards(TenantGuard, ProductAccessGuard)
export class DepositPoliciesController {
  constructor(
    @Inject(DepositPoliciesService)
    private readonly service: DepositPoliciesService,
  ) {}
  @Get() @TenantRoles('OWNER', 'ADMIN') list(@Req() r: AuthRequest) {
    return this.service.list(operator(r));
  }
  @Post() @TenantRoles('OWNER', 'ADMIN') draft(
    @Req() r: AuthRequest,
    @Body() b: unknown,
  ) {
    return this.service.draft(operator(r), b);
  }
}
