import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { AuthRequest } from '../auth/auth.types.js';
import { AuthOriginGuard } from '../auth/auth.guard.js';
import { AuthRateLimit } from '../auth/auth-rate-limit.service.js';
import { TenantGuard, TenantRoles } from '../auth/tenant.guard.js';
import { ProductAccessGuard } from '../billing/product-access.guard.js';
import { BookingsService } from './bookings.service.js';

@Controller('public/booking')
export class PublicBookingsController {
  constructor(
    @Inject(BookingsService) private readonly service: BookingsService,
    @Inject(AuthRateLimit) private readonly rateLimit: AuthRateLimit,
  ) {}

  @Get(':slug/catalog') async catalog(@Param('slug') slug: string, @Req() req: AuthRequest) {
    await this.rateLimit.consume('public-booking-catalog', req.ip ?? 'unknown', 60, 300);
    return this.service.catalog(slug);
  }

  @Get(':slug/availability') async availability(
    @Param('slug') slug: string,
    @Query('serviceId') serviceId: string,
    @Query('date') date: string,
    @Req() req: AuthRequest,
    @Query('professionalId') professionalId?: string,
  ) {
    await this.rateLimit.consume('public-booking-availability', req.ip ?? 'unknown', 120, 60);
    return this.service.availability(slug, serviceId, date, professionalId);
  }

  @Post(':slug/requests')
  @UseGuards(AuthOriginGuard)
  async request(@Param('slug') slug: string, @Body() body: unknown, @Req() req: AuthRequest) {
    await this.rateLimit.consume('public-booking-request-global', req.ip ?? 'unknown', 30, 300);
    await this.rateLimit.consume('public-booking-request', `${req.ip ?? 'unknown'}:${slug}`, 8, 300);
    return this.service.request(slug, body);
  }
}

@Controller('booking')
@UseGuards(TenantGuard, ProductAccessGuard)
export class TenantBookingsController {
  constructor(@Inject(BookingsService) private readonly service: BookingsService) {}

  @Get('requests')
  @TenantRoles('OWNER', 'ADMIN', 'RECEPTIONIST', 'PROFESSIONAL')
  requests(@Req() req: AuthRequest) {
    return this.service.listRequests(req.tenant!.companyId, req.tenant!.role, req.tenant!.membershipId);
  }

  @Post('requests/:id/accept')
  @TenantRoles('OWNER', 'ADMIN', 'RECEPTIONIST')
  accept(@Req() req: AuthRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.decide(req.tenant!.companyId, id, 'CONFIRMED');
  }

  @Post('requests/:id/reject')
  @TenantRoles('OWNER', 'ADMIN', 'RECEPTIONIST')
  reject(@Req() req: AuthRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.decide(req.tenant!.companyId, id, 'REJECTED');
  }

  @Get('services')
  @TenantRoles('OWNER', 'ADMIN', 'RECEPTIONIST', 'PROFESSIONAL')
  services(@Req() req: AuthRequest) {
    return this.service.listServices(req.tenant!.companyId);
  }

  @Post('services')
  @TenantRoles('OWNER', 'ADMIN')
  createService(@Req() req: AuthRequest, @Body() body: unknown) {
    return this.service.createService(req.tenant!.companyId, body);
  }

  @Post('setup/first-service')
  @TenantRoles('OWNER', 'ADMIN')
  setupFirstService(@Req() req: AuthRequest, @Body() body: unknown) {
    return this.service.setupFirstService(req.tenant!.companyId, body);
  }

  @Post('professionals')
  @TenantRoles('OWNER', 'ADMIN')
  createProfessional(@Req() req: AuthRequest, @Body() body: unknown) {
    return this.service.createProfessional(req.tenant!.companyId, body);
  }

  @Post('professionals/:id/availability')
  @TenantRoles('OWNER', 'ADMIN')
  availability(@Req() req: AuthRequest, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown) {
    return this.service.setAvailability(req.tenant!.companyId, id, body);
  }

  @Post('services/:id/professionals')
  @TenantRoles('OWNER', 'ADMIN')
  linkProfessionals(@Req() req: AuthRequest, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown) {
    return this.service.linkProfessionalServices(req.tenant!.companyId, id, body);
  }
}
