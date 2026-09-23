import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service.js';
import { AuthGuard, AuthOriginGuard } from './auth.guard.js';
import { TenantGuard } from './tenant.guard.js';
import { ACCESS_COOKIE, REFRESH_COOKIE } from './auth.config.js';
import { clearAuthCookies, readCookie, setAuthCookies } from './auth.http.js';
import { object } from '../common/validation.js';
import type { AuthRequest } from './auth.types.js';
@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly service: AuthService) {}
  @Post('login')
  @HttpCode(200)
  @UseGuards(AuthOriginGuard)
  async login(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const previousRefresh = readCookie(request, REFRESH_COOKIE);
    const tokens = await this.service.login(body, request.ip ?? 'unknown');
    // Logging in replaces this browser's current session, without affecting other devices.
    await this.service.logout(previousRefresh);
    setAuthCookies(response, tokens);
    return {
      authenticated: true,
      accessExpiresAt: tokens.accessExpiresAt,
      refreshExpiresAt: tokens.refreshExpiresAt,
    };
  }
  @Post('refresh')
  @HttpCode(200)
  @UseGuards(AuthOriginGuard)
  async refresh(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    object(body ?? {}, []);
    try {
      const tokens = await this.service.refresh(
        readCookie(request, REFRESH_COOKIE),
        request.ip ?? 'unknown',
      );
      setAuthCookies(response, tokens);
      return {
        authenticated: true,
        accessExpiresAt: tokens.accessExpiresAt,
        refreshExpiresAt: tokens.refreshExpiresAt,
      };
    } catch (error) {
      if (error instanceof UnauthorizedException) clearAuthCookies(response);
      throw error;
    }
  }
  @Post('logout')
  @HttpCode(204)
  @UseGuards(AuthOriginGuard)
  async logout(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    object(body ?? {}, []);
    await this.service.logout(readCookie(request, REFRESH_COOKIE));
    // Also revoke using access when a browser has lost the refresh cookie.
    try {
      const identity = await this.service.authenticate(
        readCookie(request, ACCESS_COOKIE),
      );
      await this.service.revokeCurrent(identity.session.id);
    } catch (error) {
      if (!(error instanceof UnauthorizedException)) throw error;
    }
    clearAuthCookies(response);
  }
  @Post('logout-all')
  @HttpCode(204)
  @UseGuards(AuthGuard)
  async logoutAll(
    @Body() body: unknown,
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    object(body ?? {}, []);
    await this.service.logoutAll(request.auth.user.id);
    clearAuthCookies(response);
  }
  @Get('me')
  @UseGuards(AuthGuard)
  me(@Req() request: AuthRequest) {
    return this.service.me(request.auth);
  }
  @Post('tenant')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  selectTenant(@Body() body: unknown, @Req() request: AuthRequest) {
    return this.service.selectTenant(request.auth, body);
  }
  @Get('tenant')
  @UseGuards(TenantGuard)
  tenant(@Req() request: AuthRequest) {
    return request.tenant;
  }
}
