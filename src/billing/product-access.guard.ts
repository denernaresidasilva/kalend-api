import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { AuthRequest } from '../auth/auth.types.js';
import { EntitlementsService } from './entitlements.service.js';
import { ForbiddenException } from '@nestjs/common';
/** Apply AFTER TenantGuard on future product routes; never on auth/recovery/catalog. */
@Injectable()
export class ProductAccessGuard implements CanActivate {
  constructor(
    @Inject(EntitlementsService)
    private readonly entitlements: EntitlementsService,
  ) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    if (!request.tenant) throw new ForbiddenException('TENANT_REQUIRED');
    await this.entitlements.current(request.tenant.companyId);
    return true;
  }
}
