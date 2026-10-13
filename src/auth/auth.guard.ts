import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { ACCESS_COOKIE, AuthConfig } from './auth.config.js';
import {
  clearAuthCookies,
  noStore,
  readCookie,
  requireOrigin,
} from './auth.http.js';
import type { AuthRequest } from './auth.types.js';
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(AuthService) protected readonly auth: AuthService,
    @Inject(AuthConfig) protected readonly config: AuthConfig,
  ) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    noStore(context.switchToHttp().getResponse());
    try {
      request.auth = await this.auth.authenticate(
        readCookie(request, ACCESS_COOKIE),
      );
    } catch (error) {
      if (
        error instanceof ForbiddenException &&
        (error.getResponse() as { code?: string }).code === 'NO_ACTIVE_COMPANY'
      )
        clearAuthCookies(context.switchToHttp().getResponse());
      throw error;
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method))
      requireOrigin(request, this.config);
    return true;
  }
}
@Injectable()
export class AuthOriginGuard implements CanActivate {
  constructor(@Inject(AuthConfig) private readonly config: AuthConfig) {}
  canActivate(context: ExecutionContext) {
    noStore(context.switchToHttp().getResponse());
    requireOrigin(context.switchToHttp().getRequest(), this.config);
    return true;
  }
}
