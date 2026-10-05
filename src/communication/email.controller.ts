import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from '../common/admin.guard.js';
import { TenantGuard, TenantRoles } from '../auth/tenant.guard.js';
import { AuthRateLimit } from '../auth/auth-rate-limit.service.js';
import type { AuthRequest } from '../auth/auth.types.js';
import { EmailService } from './email.js';
import type { EmailContext } from './email.js';

export abstract class EmailControllerBase {
  constructor(
    @Inject(EmailService) protected readonly email: EmailService,
    @Inject(AuthRateLimit) protected readonly limit: AuthRateLimit,
  ) {}
  protected abstract context(req: AuthRequest): EmailContext;
  @Get() get(@Req() req: AuthRequest) {
    return this.email.get(this.context(req));
  }
  @Put() save(@Req() req: AuthRequest, @Body() body: unknown) {
    return this.email.save(this.context(req), body);
  }
  @Delete() remove(@Req() req: AuthRequest) {
    return this.email.remove(this.context(req));
  }
  @Post('test') async test(@Req() req: AuthRequest, @Body() body: unknown) {
    const ctx = this.context(req);
    await this.limit.consume('communication-test', req.auth.user.id, 5, 300);
    await this.limit.consume(
      'email-test-context',
      ctx.scope === 'SYSTEM' ? 'SYSTEM' : ctx.companyId,
      5,
      300,
    );
    await this.limit.consume('email-test-platform', 'ALL', 100, 300);
    return this.email.test(ctx, body);
  }
}
@Controller('communication/email')
@UseGuards(AdminGuard)
export class SystemEmailController extends EmailControllerBase {
  protected context(): EmailContext {
    return { scope: 'SYSTEM' };
  }
}
@Controller('company/communication/email')
@UseGuards(TenantGuard)
@TenantRoles('OWNER', 'ADMIN')
export class CompanyEmailController extends EmailControllerBase {
  protected context(req: AuthRequest): EmailContext {
    return { scope: 'COMPANY', companyId: req.tenant!.companyId };
  }
}
