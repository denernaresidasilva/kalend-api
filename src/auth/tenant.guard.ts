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
export const BillingRecovery = () =>
  SetMetadata('kalend:billing-recovery', true);
// Only these tenant operations bypass commercial entitlement, never membership/role/Origin.
// Login, account/session, tenant selection and global administration use their own Auth/Admin guards.
export function billingRecoveryAllowed(method: string, path = '') {
  const route = path.replace(/\/$/, '');
  return (
    (method === 'GET' && /^\/billing\/payments\/[^/]+$/.test(route)) ||
    (method === 'POST' &&
      (route === '/billing/checkout' ||
        /^\/billing\/subscriptions\/[^/]+\/cancel$/.test(route)))
  );
}
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
      request.auth.user.isSuperAdmin ||
        ((this.reflector.getAllAndOverride<boolean>('kalend:billing-recovery', [
          context.getHandler(),
          context.getClass(),
        ]) ??
          false) &&
          billingRecoveryAllowed(request.method, request.path)),
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
