import {
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { MembershipRole } from '@prisma/client';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { AuthConfig } from './auth.config.js';
import type { AuthRequest } from './auth.types.js';
const TENANT_ROLES = 'kalend:tenant-roles';
export const TenantRoles = (...roles: MembershipRole[]) =>
  SetMetadata(TENANT_ROLES, roles);
@Injectable()
export class TenantGuard extends AuthGuard {
  constructor(
    @Inject(AuthService) auth: AuthService,
    @Inject(AuthConfig) config: AuthConfig,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {
    super(auth, config);
  }
  override async canActivate(context: ExecutionContext) {
    await super.canActivate(context);
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const companyId = request.auth.session.selectedCompanyId;
    if (!companyId)
      throw new ForbiddenException('Selecione uma empresa autorizada.');
    const membership = await this.auth.membership(
      request.auth.user.id,
      companyId,
    );
    const roles = this.reflector.getAllAndOverride<MembershipRole[]>(
      TENANT_ROLES,
      [context.getHandler(), context.getClass()],
    );
    if (roles && !roles.includes(membership.role))
      throw new ForbiddenException('Papel sem permissão para esta operação.');
    request.tenant = {
      companyId,
      membershipId: membership.id,
      role: membership.role,
    };
    return true;
  }
}
