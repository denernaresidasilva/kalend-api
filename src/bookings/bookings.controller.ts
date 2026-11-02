import { Body, Controller, ForbiddenException, UnauthorizedException, Get, Header, Sse, Inject, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AuthService } from '../auth/auth.service.js';
import { ACCESS_COOKIE } from '../auth/auth.config.js';
import { readCookie } from '../auth/auth.http.js';
import type { AuthRequest } from '../auth/auth.types.js';
import { AuthOriginGuard } from '../auth/auth.guard.js';
import { AuthRateLimit } from '../auth/auth-rate-limit.service.js';
import { TenantGuard, TenantRoles } from '../auth/tenant.guard.js';
import { ProductAccessGuard } from '../billing/product-access.guard.js';
import { CustomerAccessService } from './customer-access.service.js';
import { BookingEventsService } from './booking-events.service.js';
import { BookingsService } from './bookings.service.js';

@Controller('public/booking')
export class PublicBookingsController {
  constructor(
    @Inject(BookingsService) private readonly service: BookingsService,
    @Inject(AuthRateLimit) private readonly rateLimit: AuthRateLimit,
    @Inject(CustomerAccessService) private readonly customers: CustomerAccessService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  @Post('activate')
  @UseGuards(AuthOriginGuard)
  async activate(@Body() body: unknown, @Req() req: AuthRequest) {
    await this.rateLimit.consume('customer-activation', req.ip ?? 'unknown', 8, 900);
    const token = body && typeof body === 'object' && 'token' in body ? body.token : undefined;
    if (typeof token === 'string') await this.rateLimit.consume('customer-activation-token', token, 5, 900);
    return this.customers.activate(body);
  }

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
    let userId: string | undefined;
    const cookie = readCookie(req, ACCESS_COOKIE);
    if (cookie) {
      try { userId = (await this.auth.authenticate(cookie)).user.id; }
      catch (error) { if (!(error instanceof UnauthorizedException) && !(error instanceof ForbiddenException)) throw error; }
    }
    return this.service.request(slug, body, 0, userId);
  }
}

@Controller('booking')
@UseGuards(TenantGuard, ProductAccessGuard)
export class TenantBookingsController {
  constructor(
    @Inject(BookingsService) private readonly service: BookingsService,
    @Inject(BookingEventsService) private readonly events: BookingEventsService,
    @Inject(CustomerAccessService) private readonly customers: CustomerAccessService,
  ) {}

  @Get('customers')
  @TenantRoles('OWNER', 'ADMIN', 'RECEPTIONIST')
  customersList(@Req() req: AuthRequest) { return this.customers.customers(req.tenant!.companyId); }

  @Post('customers/:id/invitation')
  @TenantRoles('OWNER', 'ADMIN', 'RECEPTIONIST')
  invite(@Req() req: AuthRequest, @Param('id', new ParseUUIDPipe()) id: string) { return this.customers.issue(req.tenant!.companyId, id, req.auth.user.id); }

  @Get('my-requests')
  @TenantRoles('CLIENT')
  mine(@Req() req: AuthRequest) { return this.customers.mine(req.tenant!.companyId, req.auth.user.id); }

  @Sse('events')
  @Header('X-Accel-Buffering', 'no')
  @TenantRoles('OWNER', 'ADMIN', 'RECEPTIONIST', 'PROFESSIONAL')
  eventsStream(@Req() req: AuthRequest) { return this.events.stream(req); }

  @Get('agenda')
  @TenantRoles('OWNER', 'ADMIN', 'RECEPTIONIST', 'PROFESSIONAL')
  agenda(@Req() req: AuthRequest, @Query('date') date: string) {
    return this.service.agenda(req.tenant!.companyId, req.tenant!.role, req.tenant!.membershipId, date);
  }

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
