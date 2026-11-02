import { Body, Controller, Get, Inject, Module, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { TenantGuard, TenantRoles } from '../auth/tenant.guard.js';
import { ProductAccessGuard } from '../billing/product-access.guard.js';
import type { AuthRequest } from '../auth/auth.types.js';
import { OperationalAutomations } from './automations.service.js';
import { FinancialReportService } from './financial-report.service.js';
import { CommissionsService } from './commissions.service.js';
import { OperationsService, type Operator } from './operations.service.js';
export const operator = (req: AuthRequest): Operator => ({ companyId: req.tenant!.companyId, userId: req.auth.user.id, membershipId: req.tenant!.membershipId, role: req.tenant!.role });
@Controller('operations/automations')
@UseGuards(TenantGuard,ProductAccessGuard)
export class AutomationsController {
 constructor(@Inject(OperationalAutomations)private readonly service:OperationalAutomations){}
 @Get() @TenantRoles('OWNER','ADMIN') get(@Req()r:AuthRequest){return this.service.settings(operator(r));}
 @Post('template') @TenantRoles('OWNER','ADMIN') template(@Req()r:AuthRequest,@Body()b:unknown){return this.service.template(operator(r),b);}
 @Post('followup') @TenantRoles('OWNER','ADMIN') followup(@Req()r:AuthRequest,@Body()b:unknown){return this.service.followup(operator(r),b);}
 @Post('run-due') @TenantRoles('OWNER','ADMIN') due(@Req()r:AuthRequest){return this.service.due([r.tenant!.companyId]);}
 @Get('consent') @TenantRoles('CLIENT','OWNER','ADMIN','PROFESSIONAL','RECEPTIONIST') consent(@Req()r:AuthRequest){return this.service.consent(operator(r));}
 @Post('consent') @TenantRoles('CLIENT','OWNER','ADMIN','PROFESSIONAL','RECEPTIONIST') saveConsent(@Req()r:AuthRequest,@Body()b:unknown){return this.service.consent(operator(r),b);}
}
@Controller('operations/financial-report')
@UseGuards(TenantGuard, ProductAccessGuard)
export class FinancialReportController {
 constructor(@Inject(FinancialReportService) private readonly report:FinancialReportService){}
 @Get() @TenantRoles('OWNER','ADMIN','ACCOUNTANT') get(@Req() r:AuthRequest,@Query() q:Record<string,string>){return this.report.report(operator(r),q);}
}
@Controller('operations/commissions')
@UseGuards(TenantGuard, ProductAccessGuard)
export class CommissionsController {
 constructor(@Inject(CommissionsService) private readonly commissions: CommissionsService) {}
 @Get() @TenantRoles('OWNER','ADMIN','PROFESSIONAL') list(@Req() r:AuthRequest){return this.commissions.list(operator(r));}
 @Post('rules') @TenantRoles('OWNER','ADMIN') rule(@Req() r:AuthRequest,@Body() b:unknown){return this.commissions.rules(operator(r),b);}
 @Post(':id/release') @TenantRoles('OWNER','ADMIN') release(@Req() r:AuthRequest,@Param('id',new ParseUUIDPipe()) id:string){return this.commissions.release(operator(r),id);}
 @Post(':id/pay') @TenantRoles('OWNER','ADMIN') pay(@Req() r:AuthRequest,@Param('id',new ParseUUIDPipe()) id:string,@Body() b:unknown){return this.commissions.pay(operator(r),id,b);}
 @Post(':id/adjust') @TenantRoles('OWNER','ADMIN') adjust(@Req() r:AuthRequest,@Param('id',new ParseUUIDPipe()) id:string,@Body() b:unknown){return this.commissions.adjust(operator(r),id,b);}
}
@Controller('operations')
@UseGuards(TenantGuard, ProductAccessGuard)
export class OperationsController {
  constructor(@Inject(OperationsService) private readonly ops: OperationsService) {}
  @Get('board') @TenantRoles('OWNER', 'ADMIN', 'RECEPTIONIST', 'PROFESSIONAL') board(@Req() r: AuthRequest) { return this.ops.board(operator(r)); }
  @Get('catalog') @TenantRoles('OWNER', 'ADMIN', 'RECEPTIONIST') catalog(@Req() r: AuthRequest) { return this.ops.catalog(operator(r)); }
  @Post('products') @TenantRoles('OWNER', 'ADMIN') product(@Req() r: AuthRequest, @Body() b: unknown) { return this.ops.createProduct(operator(r), b); }
  @Post('coupons') @TenantRoles('OWNER', 'ADMIN') couponCreate(@Req() r: AuthRequest, @Body() b: unknown) { return this.ops.createCoupon(operator(r), b); }
  @Post('cash/open') @TenantRoles('OWNER', 'ADMIN', 'RECEPTIONIST') cashOpen(@Req() r: AuthRequest, @Body() b: unknown) { return this.ops.cashOpen(operator(r), b); }
  @Post('cash/:id/close') @TenantRoles('OWNER', 'ADMIN', 'RECEPTIONIST') cashClose(@Req() r: AuthRequest, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: unknown) { return this.ops.cashClose(operator(r), id, b); }
  @Post('sales') @TenantRoles('OWNER', 'ADMIN', 'RECEPTIONIST') sale(@Req() r: AuthRequest, @Body() b: unknown) { return this.ops.openSale(operator(r), b); }
  @Post('sales/:id/lines') @TenantRoles('OWNER', 'ADMIN', 'RECEPTIONIST') line(@Req() r: AuthRequest, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: unknown) { return this.ops.addLine(operator(r), id, b); }
  @Post('lines/:id/start') @TenantRoles('OWNER', 'ADMIN', 'RECEPTIONIST', 'PROFESSIONAL') start(@Req() r: AuthRequest, @Param('id', new ParseUUIDPipe()) id: string) { return this.ops.lineAction(operator(r), id, 'start'); }
  @Post('lines/:id/complete') @TenantRoles('OWNER', 'ADMIN', 'RECEPTIONIST', 'PROFESSIONAL') complete(@Req() r: AuthRequest, @Param('id', new ParseUUIDPipe()) id: string) { return this.ops.lineAction(operator(r), id, 'complete'); }
  @Post('lines/:id/void') @TenantRoles('OWNER', 'ADMIN', 'RECEPTIONIST') voidLine(@Req() r: AuthRequest, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: unknown) { return this.ops.lineAction(operator(r), id, 'void', b); }
  @Post('sales/:id/discount') @TenantRoles('OWNER', 'ADMIN') discount(@Req() r: AuthRequest, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: unknown) { return this.ops.discount(operator(r), id, b); }
  @Post('sales/:id/coupon') @TenantRoles('OWNER', 'ADMIN', 'RECEPTIONIST') coupon(@Req() r: AuthRequest, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: unknown) { return this.ops.coupon(operator(r), id, b); }
  @Post('sales/:id/payments') @TenantRoles('OWNER', 'ADMIN', 'RECEPTIONIST') pay(@Req() r: AuthRequest, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: unknown) { return this.ops.receive(operator(r), id, b); }
  @Post('sales/:id/finalize') @TenantRoles('OWNER', 'ADMIN', 'RECEPTIONIST') finalize(@Req() r: AuthRequest, @Param('id', new ParseUUIDPipe()) id: string) { return this.ops.finalize(operator(r), id); }
  @Post('receipts/:id/refund') @TenantRoles('OWNER', 'ADMIN') refund(@Req() r: AuthRequest, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: unknown) { return this.ops.refund(operator(r), id, b); }
  @Post('sales/:id/cancel') @TenantRoles('OWNER', 'ADMIN', 'RECEPTIONIST') cancel(@Req() r: AuthRequest, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: unknown) { return this.ops.cancel(operator(r), id, b); }
}
@Module({ imports: [AuthModule, BillingModule], controllers: [OperationsController, CommissionsController, FinancialReportController, AutomationsController], providers: [OperationsService, CommissionsService, FinancialReportService, OperationalAutomations], exports: [OperationsService, OperationalAutomations] })
export class OperationsModule {}
