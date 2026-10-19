import { CanActivate, ExecutionContext, HttpStatus, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppException } from '../errors/app-exception';
import { ALLOW_DURING_MAINTENANCE_KEY } from './allow-during-maintenance.decorator';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const MAINTENANCE_RETRY_AFTER_SECONDS = 60;

export class MaintenanceReadOnlyException extends AppException {
  constructor() {
    super(HttpStatus.SERVICE_UNAVAILABLE, 'MAINTENANCE_READ_ONLY', {
      uz: "Tizim texnik xizmat rejimida: hozircha faqat o'qish mumkin. Birozdan keyin qayta urinib ko'ring",
      ru: 'Система на техническом обслуживании: доступно только чтение. Повторите попытку позже',
      en: 'The system is under maintenance and read-only. Please retry shortly',
    });
  }
}

/**
 * ADR-051 read-only mode (READ_ONLY_MODE=true). Registered FIRST among global guards so a write is
 * refused before JWT verification / the tenant transaction is ever opened. Whatever a non-safe
 * method would write (including report/company exports that persist an ExportJob + storage object)
 * counts as a write and is blocked, except handlers marked @AllowDuringMaintenance.
 * No AuditLog row is written at startup: AuditLog.companyId is NOT NULL, there is no system tenant.
 */
@Injectable()
export class MaintenanceGuard implements CanActivate, OnModuleInit {
  private readonly logger = new Logger(MaintenanceGuard.name);
  private readonly readOnly: boolean;

  constructor(private readonly reflector: Reflector) {
    // Read from process.env (validated by env.schema.ts at boot; ConfigModule also exports .env files into it)
    // so e2e tests can rebuild the app with a different value.
    this.readOnly = process.env.READ_ONLY_MODE === 'true';
  }

  onModuleInit(): void {
    if (this.readOnly) this.logger.warn('READ_ONLY_MODE is ON: all POST/PUT/PATCH/DELETE are refused with 503 MAINTENANCE_READ_ONLY');
  }

  canActivate(context: ExecutionContext): boolean {
    if (!this.readOnly) return true;
    const req = context.switchToHttp().getRequest<{ method: string }>();
    if (SAFE_METHODS.has(req.method.toUpperCase())) return true;
    const allowed = this.reflector.getAllAndOverride<boolean>(ALLOW_DURING_MAINTENANCE_KEY, [context.getHandler(), context.getClass()]);
    if (allowed) return true;
    context.switchToHttp().getResponse<{ setHeader(k: string, v: string): void }>().setHeader('Retry-After', String(MAINTENANCE_RETRY_AFTER_SECONDS));
    throw new MaintenanceReadOnlyException();
  }
}
