import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, from, type Observable } from 'rxjs';
import { AuditLogService } from '../audit/audit-log.service';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { REQUIRE_PERMISSION_KEY } from '../decorators/require-permission.decorator';
import { PermissionDeniedException } from './auth-exceptions';
import type { AccessTokenPayload, AuthenticatedUser } from './auth.types';

/**
 * Runs every non-@Public request inside one RLS transaction
 * (`TenantPrismaService.run`), hydrates `request.user` from the DB (never
 * trusting the JWT payload for roles/permissions — those can change inside
 * a token's 15-minute lifetime), and enforces `@RequirePermission`. This is
 * where PermissionsGuard-style logic lives: a Guard can't wrap next.handle(),
 * and the transaction needs to stay open for the controller/service that
 * follows, so it has to be an interceptor.
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly reflector: Reflector,
    private readonly auditLog: AuditLogService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return next.handle();
    }

    return from(this.runInTenantContext(context, next));
  }

  private async runInTenantContext(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest();
    const payload = request.tokenPayload as AccessTokenPayload | undefined;
    if (!payload) {
      // Safety net only — JwtAuthGuard already rejects non-@Public requests
      // without a valid token before this interceptor ever runs.
      throw new UnauthorizedException();
    }

    const requiredPermission = this.reflector.getAllAndOverride<string | undefined>(REQUIRE_PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    return this.tenantPrisma.run(payload.companyId, async (tx) => {
      const user = await tx.user.findUnique({ where: { id: payload.sub } });
      if (!user || !user.isActive) {
        throw new UnauthorizedException();
      }

      const userRoles = await tx.userRole.findMany({
        where: { userId: user.id },
        include: { role: { include: { permissions: { include: { permission: true } } } } },
      });

      const roles = userRoles.map((ur) => ur.role.code);
      const permissions = [
        ...new Set(
          userRoles.flatMap((ur) =>
            ur.role.permissions.map((rp) => `${rp.permission.module}.${rp.permission.code}`),
          ),
        ),
      ];

      if (requiredPermission && !permissions.includes(requiredPermission)) {
        // SEC-020..024 / SEC-054: "ruxsat rad etilsa 403 + audit" — logged
        // against the acting user themselves (there's no other natural
        // entity for a denied permission check on an arbitrary route).
        // Written in its own transaction (like AuthService.logFailedLogin):
        // throwing here rolls back `tx`, which would take the audit row with it.
        await this.tenantPrisma.run(payload.companyId, (auditTx) =>
          this.auditLog.log(auditTx, {
            companyId: payload.companyId,
            userId: user.id,
            action: 'auth.permission_denied',
            entity: 'User',
            entityId: user.id,
            newValue: { permission: requiredPermission, method: request.method, path: request.url },
          }),
        );
        throw new PermissionDeniedException(requiredPermission);
      }

      const authenticatedUser: AuthenticatedUser = {
        id: user.id,
        companyId: payload.companyId,
        firstName: user.firstName,
        lastName: user.lastName,
        roles,
        permissions,
      };
      request.user = authenticatedUser;

      return firstValueFrom(next.handle());
    });
  }
}
