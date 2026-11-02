import { createHmac } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { OfflineKekVersionRetiredException, SessionExpiredException } from '../../common/auth/auth-exceptions';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { parsePreviousKekSecrets } from '../../common/config/offline-kek-keyring';
import { RateLimitedException } from '../../common/throttle/user-throttler.guard';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { LoginRateLimiterService } from './login-rate-limiter.service';

export interface OfflineKek {
  kek: string;
  version: number;
  currentVersion: number;
}

export const OFFLINE_KEK_RATE_LIMIT = 10;
export const OFFLINE_KEK_RATE_WINDOW_SECONDS = 60;

/**
 * Per-(companyId, userId) key-encryption key for wrapping on-device vault keys.
 * KEK = HMAC-SHA256(secret[version], `velto-offline-kek:v<version>:<companyId>:<userId>`), deterministic,
 * never persisted/logged/audited. Versioned keyring: current secret + optional previous ones (rotation).
 */
@Injectable()
export class OfflineKekService {
  constructor(
    private readonly config: ConfigService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly auditLog: AuditLogService,
    private readonly limiter: LoginRateLimiterService,
  ) {}

  currentVersion(): number {
    return Number(this.config.get<number>('OFFLINE_KEK_VERSION', 1));
  }

  /** Pure derivation. Unknown/retired version => OfflineKekVersionRetiredException. */
  derive(companyId: string, userId: string, version?: number): OfflineKek {
    const currentVersion = this.currentVersion();
    const target = version ?? currentVersion;
    const secret = this.secretFor(target, currentVersion);
    if (!secret) throw new OfflineKekVersionRetiredException();
    const kek = createHmac('sha256', secret).update(`velto-offline-kek:v${target}:${companyId}:${userId}`).digest('base64url');
    return { kek, version: target, currentVersion };
  }

  private secretFor(version: number, currentVersion: number): string | undefined {
    if (version === currentVersion) return this.config.getOrThrow<string>('OFFLINE_KEK_SECRET');
    return parsePreviousKekSecrets(this.config.get<string>('OFFLINE_KEK_PREVIOUS_SECRETS'), currentVersion).map.get(version);
  }

  /**
   * Endpoint flow (runs without an open request tx; each DB step uses its own short tenant tx so denial audits persist):
   * per-user rate limit -> session (sid) still active -> version known -> audit issuance.
   */
  async issue(user: AuthenticatedUser, versionParam: string | undefined, ip?: string): Promise<OfflineKek> {
    try {
      await this.limiter.hit(`offline-kek:${user.id}`, OFFLINE_KEK_RATE_LIMIT, OFFLINE_KEK_RATE_WINDOW_SECONDS);
    } catch (err) {
      if (err instanceof RateLimitedException) await this.audit(user, 'auth.offline_kek.denied', { reason: 'rate_limited' }, ip);
      throw err;
    }

    const active = user.sid
      ? await this.tenantPrisma.run(user.companyId, (tx) =>
          tx.refreshToken.findFirst({
            where: { familyId: user.sid, userId: user.id, revokedAt: null, expiresAt: { gt: new Date() } },
            select: { id: true },
          }),
        )
      : null;
    if (!active) {
      await this.audit(user, 'auth.offline_kek.denied', { reason: 'session_revoked' }, ip);
      throw new SessionExpiredException();
    }

    let result: OfflineKek;
    try {
      result = this.derive(user.companyId, user.id, versionParam === undefined ? undefined : Number(versionParam));
    } catch (err) {
      if (err instanceof OfflineKekVersionRetiredException) {
        await this.audit(user, 'auth.offline_kek.denied', { reason: 'version_retired', version: Number(versionParam) }, ip);
      }
      throw err;
    }
    await this.audit(user, 'auth.offline_kek.issued', { version: result.version }, ip);
    return result;
  }

  private audit(user: AuthenticatedUser, action: string, newValue: Record<string, string | number>, ip?: string): Promise<void> {
    return this.tenantPrisma.run(user.companyId, (tx) =>
      this.auditLog.log(tx, { companyId: user.companyId, userId: user.id, action, entity: 'User', entityId: user.id, newValue, ip }),
    );
  }
}
