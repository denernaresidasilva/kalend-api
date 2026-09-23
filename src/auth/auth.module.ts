import { PrismaModule } from '../prisma/prisma.module.js';
import { Global, Module } from '@nestjs/common';
import { AuthConfig } from './auth.config.js';
import { AuthTokens } from './auth.tokens.js';
import { AuthService } from './auth.service.js';
import { AuthRateLimit } from './auth-rate-limit.service.js';
import { AuthGuard, AuthOriginGuard } from './auth.guard.js';
import { TenantGuard } from './tenant.guard.js';
import { AdminGuard } from '../common/admin.guard.js';
import { AuthController } from './auth.controller.js';
@Global()
@Module({
  imports: [PrismaModule],
  controllers: [AuthController],
  providers: [
    AuthConfig,
    AuthTokens,
    AuthService,
    AuthRateLimit,
    AuthGuard,
    AuthOriginGuard,
    TenantGuard,
    AdminGuard,
  ],
  exports: [AuthConfig, AuthService, AuthGuard, TenantGuard, AdminGuard],
})
export class AuthModule {}
