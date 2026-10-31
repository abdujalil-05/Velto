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
import { MfaRequiredException, PermissionDeniedException } from './auth-exceptions';
import { isMfaSessionValid } from './mfa-policy';
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
    let mfaDenied: AuthenticatedUser | undefined;

    const result = await this.tenantPrisma.run(payload.companyId, async (tx) => {
      // Deactivated user or company -> 401 (client then tries /auth/refresh -> 403 AUTH_ACCOUNT_BLOCKED).
      const loaded = await loadAuthenticatedUser(tx, payload.sub, payload.companyId);
      if (!loaded) {
        throw new UnauthorizedException();
      }
      const { confirmedMfaId, ...actor } = loaded;
      // ADR-058: privileged roles need a session backed by the current confirmed MFA (checked against DB roles, not the JWT).
      if (!isMfaSessionValid(actor.roles, confirmedMfaId, payload.mfa)) {
        mfaDenied = actor;
        return undefined;
      }
      const { permissions } = actor;

      if (requiredPermission && !permissions.includes(requiredPermission)) {
        // Commit this short tx cleanly, then audit + throw outside it (no nested tx):
        // throwing here would roll back `tx` (and the audit row), and a second
        // run() while this tx is open can self-wait on the pool.
        denied = actor;
        return undefined;
      }

      request.user = payload.sid ? { ...actor, sid: payload.sid } : actor;
      if (handlerScope) return undefined;
      return firstValueFrom(next.handle());
    }, handlerScope || Object.keys(txOptions).length === 0 ? undefined : txOptions);

    if (mfaDenied) {
      const m = mfaDenied;
      await this.tenantPrisma.run(payload.companyId, (auditTx) =>
        this.auditLog.log(auditTx, {
          companyId: payload.companyId,
          userId: m.id,
          action: 'auth.mfa.denied',
          entity: 'User',
          entityId: m.id,
          newValue: { method: request.method, path: request.url },
        }),
      );
      throw new MfaRequiredException();
    }
    if (denied) {
      const d = denied;
      // SEC-020..024 / SEC-054: "ruxsat rad etilsa 403 + audit" — logged
      // against the acting user themselves, in its own tx (like AuthService.logFailedLogin).
      await this.tenantPrisma.run(payload.companyId, (auditTx) =>
        this.logDenied(auditTx, payload.companyId, d.id, requiredPermission!, request),
      );
      throw new PermissionDeniedException(requiredPermission!);
    }
    if (!handlerScope) return result;
    // handler scope: short auth tx is committed; the handler now runs with no open tx.
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
