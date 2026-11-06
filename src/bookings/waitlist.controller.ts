import { Body,Controller,ForbiddenException,Get,Inject,Param,ParseUUIDPipe,Post,Req,UseGuards } from '@nestjs/common';
import { AuthOriginGuard } from '../auth/auth.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { AuthRateLimit } from '../auth/auth-rate-limit.service.js';
import { ACCESS_COOKIE } from '../auth/auth.config.js';
import { readCookie } from '../auth/auth.http.js';
import type { AuthRequest } from '../auth/auth.types.js';
import { TenantGuard,TenantRoles } from '../auth/tenant.guard.js';
import { ProductAccessGuard } from '../billing/product-access.guard.js';
import { operator } from '../operations/operations.module.js';
import { WaitlistService } from './waitlist.service.js';
import { BookingsService } from './bookings.service.js';
import { object,string } from '../common/validation.js';
@Controller('public/booking/:slug/waitlist')
@UseGuards(AuthOriginGuard)
export class PublicWaitlistController{
 constructor(@Inject(WaitlistService)private readonly service:WaitlistService,@Inject(AuthService)private readonly auth:AuthService,@Inject(AuthRateLimit)private readonly limits:AuthRateLimit){}
 private async user(req:AuthRequest,required=false){const cookie=readCookie(req,ACCESS_COOKIE);if(!cookie){if(required)throw new ForbiddenException('Entre na sua conta.');return undefined;}return(await this.auth.authenticate(cookie)).user.id;}
 @Post()async join(@Param('slug')slug:string,@Body()b:unknown,@Req()r:AuthRequest){await this.limits.consume('waitlist-join',r.ip??'unknown',8,300);return this.service.join(slug,b,await this.user(r));}
 @Get('mine')async mine(@Param('slug')slug:string,@Req()r:AuthRequest){await this.limits.consume('waitlist-mine',r.ip??'unknown',60,300);return this.service.mine(slug,(await this.user(r,true))!);}
 @Post(':id/cancel')async cancel(@Param('slug')slug:string,@Param('id',new ParseUUIDPipe())id:string,@Req()r:AuthRequest){await this.limits.consume('waitlist-cancel',r.ip??'unknown',20,300);return this.service.cancel(slug,id,(await this.user(r,true))!);}
}
@Controller('booking/waitlist')
@UseGuards(TenantGuard,ProductAccessGuard)
export class TenantWaitlistController{
 constructor(@Inject(WaitlistService)private readonly service:WaitlistService){}
 @Get()@TenantRoles('OWNER','ADMIN','RECEPTIONIST')board(@Req()r:AuthRequest){return this.service.board(operator(r));}
 @Get('settings')@TenantRoles('OWNER','ADMIN')settings(@Req()r:AuthRequest){return this.service.settings(operator(r));}
 @Post('settings')@TenantRoles('OWNER','ADMIN')configure(@Req()r:AuthRequest,@Body()b:unknown){return this.service.settings(operator(r),b);}
 @Post('match')@TenantRoles('OWNER','ADMIN')match(@Req()r:AuthRequest){return this.service.match([r.tenant!.companyId]);}
}
@Controller('booking/requests')
@UseGuards(TenantGuard,ProductAccessGuard)
export class BookingCancellationController{
 constructor(@Inject(BookingsService)private readonly service:BookingsService){}
 @Post(':id/cancel')@TenantRoles('OWNER','ADMIN','RECEPTIONIST')cancel(@Req()r:AuthRequest,@Param('id',new ParseUUIDPipe())id:string,@Body()b:unknown){const v=object(b,['reason']);return this.service.cancel(r.tenant!.companyId,id,r.auth.user.id,string(v.reason,'reason',1000));}
}
