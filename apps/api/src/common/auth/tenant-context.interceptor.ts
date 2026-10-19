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
import { TenantContext, handlerScopeStore } from '../tenant/tenant-context';
import { TENANT_TX_OPTIONS_KEY, type TenantTxRouteOptions } from '../tenant/tenant-tx-options.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { REQUIRE_PERMISSION_KEY } from '../decorators/require-permission.decorator';
import { PermissionDeniedException } from './auth-exceptions';
import { loadAuthenticatedUser } from './load-authenticated-user';
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

    const routeOptions = this.reflector.getAllAndOverride<TenantTxRouteOptions | undefined>(TENANT_TX_OPTIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const { scope, ...txOptions } = routeOptions ?? {};
    const handlerScope = scope === 'handler';
    let denied: AuthenticatedUser | undefined;

    const result = await this.tenantPrisma.run(payload.companyId, async (tx) => {
      // Deactivated user or company -> 401 (client then tries /auth/refresh -> 403 AUTH_ACCOUNT_BLOCKED).
      const actor = await loadAuthenticatedUser(tx, payload.sub, payload.companyId);
      if (!actor) {
        throw new UnauthorizedException();
      }
      const { permissions } = actor;

      if (requiredPermission && !permissions.includes(requiredPermission)) {
        if (handlerScope) {
          // Commit this short tx cleanly, then audit + throw outside it (no nested tx).
          denied = actor;
          return undefined;
        }
        // SEC-020..024 / SEC-054: "ruxsat rad etilsa 403 + audit" — logged
        // against the acting user themselves (there's no other natural
        // entity for a denied permission check on an arbitrary route).
        // Written in its own transaction (like AuthService.logFailedLogin):
        // throwing here rolls back `tx`, which would take the audit row with it.
        await this.tenantPrisma.run(
          payload.companyId,
          (auditTx) => this.logDenied(auditTx, payload.companyId, actor.id, requiredPermission, request),
          undefined,
          { allowNested: true },
        );
        throw new PermissionDeniedException(requiredPermission);
      }

      request.user = actor;
      if (handlerScope) return undefined;
      return firstValueFrom(next.handle());
    }, handlerScope || Object.keys(txOptions).length === 0 ? undefined : txOptions);

    if (!handlerScope) return result;
    // handler scope: short auth tx is committed; the handler now runs with no open tx.
    if (denied) {
      const d = denied;
      await this.tenantPrisma.run(payload.companyId, (auditTx) =>
        this.logDenied(auditTx, payload.companyId, d.id, requiredPermission!, request),
      );
      throw new PermissionDeniedException(requiredPermission!);
    }
    return TenantContext.run(handlerScopeStore(payload.companyId), () => firstValueFrom(next.handle()));
  }

  private logDenied(
    auditTx: Parameters<AuditLogService['log']>[0],
    companyId: string,
    userId: string,
    permission: string,
    request: { method: string; url: string },
  ) {
    return this.auditLog.log(auditTx, {
      companyId,
      userId,
      action: 'auth.permission_denied',
      entity: 'User',
      entityId: userId,
      newValue: { permission, method: request.method, path: request.url },
    });
  }
}
