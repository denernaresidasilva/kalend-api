import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { TenantGuard, TenantRoles } from '../auth/tenant.guard.js';
import type { AuthRequest } from '../auth/auth.types.js';
import { AuthRateLimit } from '../auth/auth-rate-limit.service.js';
import { object, string } from '../common/validation.js';
import { AdminGuard } from '../common/admin.guard.js';
import { GLOBAL_EVOLUTION, EvolutionService } from './evolution.js';

@Controller('company/communication/evolution')
@UseGuards(TenantGuard)
@TenantRoles('OWNER', 'ADMIN')
export class CompanyEvolutionController {
  constructor(
    @Inject(EvolutionService) private readonly evolution: EvolutionService,
    @Inject(AuthRateLimit) private readonly limit: AuthRateLimit,
  ) {}
  protected context(req: AuthRequest): string | typeof GLOBAL_EVOLUTION {
    return req.tenant!.companyId;
  }
  @Get() get(@Req() req: AuthRequest) {
    return this.evolution.get(this.context(req));
  }
  @Get('status') status(@Req() req: AuthRequest) {
    return this.get(req);
  }
  private async throttle(req: AuthRequest) {
    await this.limit.consume(
      'evolution-management',
      typeof this.context(req) === 'string'
        ? (this.context(req) as string)
        : 'GLOBAL',
      10,
      300,
    );
  }
  @Post('prepare') async prepare(
    @Req() req: AuthRequest,
    @Body() body: unknown,
  ) {
    object(body ?? {}, []);
    await this.throttle(req);
    return this.evolution.prepare(this.context(req));
  }
  @Post('connect') async connect(
    @Req() req: AuthRequest,
    @Body() body: unknown,
  ) {
    object(body ?? {}, []);
    await this.throttle(req);
    return this.evolution.connect(this.context(req));
  }
  @Post('reconnect') reconnect(@Req() req: AuthRequest, @Body() body: unknown) {
    return this.connect(req, body);
  }
  @Post('pairing-code') async pair(
    @Req() req: AuthRequest,
    @Body() body: unknown,
  ) {
    const value = object(body, ['phone']);
    const phone = string(value.phone, 'phone', 32);
    await this.throttle(req);
    return this.evolution.connect(this.context(req), phone);
  }
  @Post('logout') async logout(@Req() req: AuthRequest, @Body() body: unknown) {
    object(body ?? {}, []);
    await this.throttle(req);
    return this.evolution.logout(this.context(req));
  }
  @Delete() async remove(@Req() req: AuthRequest, @Body() body: unknown) {
    object(body ?? {}, []);
    await this.throttle(req);
    return this.evolution.remove(this.context(req));
  }
}
@Controller('communication/evolution')
@UseGuards(AdminGuard)
export class GlobalEvolutionController extends CompanyEvolutionController {
  protected override context(): typeof GLOBAL_EVOLUTION {
    return GLOBAL_EVOLUTION;
  }
}
@Controller('webhooks/communication/evolution')
export class EvolutionWebhookController {
  constructor(
    @Inject(EvolutionService) private readonly evolution: EvolutionService,
  ) {}
  @Post('global/:id') globalReceive(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('x-kalend-evolution-token') token: string | undefined,
    @Body() body: unknown,
  ) {
    return this.evolution.webhook(id, token, body, 'GLOBAL');
  }
  @Post(':id') receive(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('x-kalend-evolution-token') token: string | undefined,
    @Body() body: unknown,
  ) {
    return this.evolution.webhook(id, token, body);
  }
}
