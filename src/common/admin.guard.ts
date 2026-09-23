import {
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { AuthConfig } from '../auth/auth.config.js';
import type { AuthRequest } from '../auth/auth.types.js';
@Injectable()
export class AdminGuard extends AuthGuard {
  constructor(
    @Inject(AuthService) auth: AuthService,
    @Inject(AuthConfig) config: AuthConfig,
  ) {
    super(auth, config);
  }
  override async canActivate(context: ExecutionContext) {
    await super.canActivate(context);
    if (
      !context.switchToHttp().getRequest<AuthRequest>().auth.user.isSuperAdmin
    )
      throw new ForbiddenException(
        'Privilégio global de Super Admin necessário.',
      );
    return true;
  }
}
