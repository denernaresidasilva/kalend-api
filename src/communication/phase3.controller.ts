import { object } from '../common/validation.js';
import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthGuard } from '../auth/auth.guard.js';
import { AdminGuard } from '../common/admin.guard.js';
import { AuthRateLimit } from '../auth/auth-rate-limit.service.js';
import type { AuthRequest } from '../auth/auth.types.js';
import { readCookie } from '../auth/auth.http.js';
import { GMAIL_COOKIE, GmailTransport } from './gmail.js';
import { GlobalPush } from './push.js';

@Controller('communication/gmail')
export class GmailController {
  constructor(
    @Inject(GmailTransport) private readonly gmail: GmailTransport,
    @Inject(AuthRateLimit) private readonly limit: AuthRateLimit,
  ) {}
  @Get('status') @UseGuards(AdminGuard) status() {
    return this.gmail.status();
  }
  @Post('connect')
  @UseGuards(AdminGuard)
  async connect(
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ) {
    object(body ?? {}, []);
    await this.limit.consume('gmail-connect', req.auth.user.id, 3, 600);
    await this.limit.consume('gmail-connect-global', 'GLOBAL', 10, 600);
    const result = await this.gmail.connect(req.auth);
    res.cookie(GMAIL_COOKIE, result.binding, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 600000,
    });
    return { authorizationUrl: result.authorizationUrl, expiresIn: 600 };
  }
  // Public protocol callback; one-use state + browser binding + live initiating admin session replace JWT guard here.
  @Get('callback')
  async callback(
    @Query('state') state: unknown,
    @Query('code') code: unknown,
    @Query('error') error: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; frame-ancestors 'none'",
    );
    const binding = readCookie(req, GMAIL_COOKIE);
    res.clearCookie(GMAIL_COOKIE, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
    });
    try {
      const result = await this.gmail.callback(
        state,
        code,
        binding,
        error !== undefined,
      );
      // No scripts, assets, secrets, redirects or reflected callback parameters.
      return res
        .status(200)
        .type('text/plain')
        .send(
          result.connected
            ? 'Gmail conectado. Volte ao Kalend.'
            : 'Autorização cancelada. Volte ao Kalend.',
        );
    } catch {
      return res
        .status(400)
        .type('text/plain')
        .send(
          'Não foi possível conectar Gmail. Inicie uma nova conexão no Kalend.',
        );
    }
  }
  @Post('disconnect')
  @UseGuards(AdminGuard)
  async disconnect(@Req() req: AuthRequest) {
    await this.limit.consume('gmail-connect', req.auth.user.id, 3, 600);
    return this.gmail.disconnect(req.auth.user.id);
  }
}
@Controller('communication/push')
@UseGuards(AuthGuard)
export class PushController {
  constructor(
    @Inject(GlobalPush) private readonly push: GlobalPush,
    @Inject(AuthRateLimit) private readonly limit: AuthRateLimit,
  ) {}
  @Get('public-config') config() {
    return this.push.publicConfiguration();
  }
  @Get('subscriptions') list(
    @Req() req: AuthRequest,
    @Query('endpointHash') endpointHash?: string,
  ) {
    return this.push.list(
      req.auth.user.id,
      req.auth.session.selectedCompanyId ?? undefined,
      endpointHash,
    );
  }
  @Post('subscriptions') async register(
    @Req() req: AuthRequest,
    @Body() body: unknown,
  ) {
    await this.limit.consume('push-register', req.auth.user.id, 20, 300);
    return this.push.register(
      req.auth.user.id,
      body,
      req.auth.session.selectedCompanyId ?? undefined,
    );
  }
  @Put('subscriptions/:id') async active(
    @Req() req: AuthRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ) {
    await this.limit.consume('push-register', req.auth.user.id, 20, 300);
    return this.push.setActive(
      req.auth.user.id,
      id,
      body,
      req.auth.session.selectedCompanyId ?? undefined,
    );
  }
  @Delete('subscriptions/:id') async revoke(
    @Req() req: AuthRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    await this.limit.consume('push-register', req.auth.user.id, 20, 300);
    return this.push.revoke(
      req.auth.user.id,
      id,
      req.auth.session.selectedCompanyId ?? undefined,
    );
  }
}
