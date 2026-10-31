import { Injectable } from '@nestjs/common';
import argon2 from 'argon2';
import type { TenantClient } from '@velto/database';
import { AuditLogService } from '../../common/audit/audit-log.service';
import {
  AuthChallengeRateLimitedException,
  MfaChallengeInvalidException,
  MfaCodeInvalidException,
  MfaRateLimitedException,
  MfaServiceUnavailableException,
  TooManyLoginAttemptsException,
} from '../../common/auth/auth-exceptions';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { SecretBox, type SealedSecret } from '../../common/crypto/secret-box';
import { ServiceUnavailableAppException } from '../../common/redis/redis-unavailable';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { AuthChallengeStore, CHALLENGE_TTL_SECONDS, type MfaBinding } from './auth-challenge.store';
import { AuthService, type MfaStepRequired, type RequestMeta, type TokenPair } from './auth.service';
import type { MfaEnrollConfirmDto, MfaReenrollDto, MfaVerifyDto, RegenerateRecoveryCodesDto } from './dto/mfa.dto';
import { LoginRateLimiterService } from './login-rate-limiter.service';
import { findMatchingRecoveryCode, generateRecoveryCodes } from './mfa-recovery-codes';
import { checkTotp, newTotpSecret, totpEnrollmentArtifacts } from './mfa-totp';

const IP_MAX_PER_WINDOW = 10;
const IP_WINDOW_SECONDS = 5 * 60;

export interface EnrollStart {
  otpauthUri: string;
  secret: string;
  qrDataUrl: string;
}

export type MfaSession = TokenPair & { recoveryCodes?: string[] };

function findConfirmedMfa(tx: TenantClient, userId: string) {
  return tx.userMfa.findFirst({ where: { userId, confirmedAt: { not: null } } });
}

type MfaRow = NonNullable<Awaited<ReturnType<typeof findConfirmedMfa>>>;

const aadOf = (companyId: string, userId: string): string => `${companyId}:${userId}`;

function toSealed(row: { secretCiphertext: Uint8Array; secretIv: Uint8Array; secretTag: Uint8Array; keyVersion: number }): SealedSecret {
  return { ciphertext: Buffer.from(row.secretCiphertext), iv: Buffer.from(row.secretIv), tag: Buffer.from(row.secretTag), keyVersion: row.keyVersion };
}

function encodePending(s: SealedSecret): string {
  return JSON.stringify({ c: s.ciphertext.toString('base64'), i: s.iv.toString('base64'), t: s.tag.toString('base64'), v: s.keyVersion });
}

function decodePending(raw: string): SealedSecret {
  const p = JSON.parse(raw) as { c: string; i: string; t: string; v: number };
  return { ciphertext: Buffer.from(p.c, 'base64'), iv: Buffer.from(p.i, 'base64'), tag: Buffer.from(p.t, 'base64'), keyVersion: p.v };
}

/**
 * ADR-058 mandatory TOTP MFA: enrollment, verification, self-service change and
 * recovery codes. Token issuance is delegated to AuthService (one session
 * factory); every check that grants a session fails closed.
 */
@Injectable()
export class MfaService {
  constructor(
    private readonly auth: AuthService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly challenges: AuthChallengeStore,
    private readonly rateLimiter: LoginRateLimiterService,
    private readonly auditLog: AuditLogService,
    private readonly secretBox: SecretBox,
  ) {}

  // ---- public (challenge-bound) endpoints --------------------------------

  /** Generates (or replaces) the pending TOTP secret of an enroll challenge. Nothing is persisted in Postgres until confirm. */
  async startEnroll(mfaChallenge: string, meta: RequestMeta): Promise<EnrollStart> {
    await this.throttleIp(meta);
    const binding = await this.challenges.readMfa(mfaChallenge, 'mfa_enroll');
    await this.assertUserNotLimited(binding.userId);
    const user = await this.tenantPrisma.run(binding.companyId, (tx) => this.findActiveUser(tx, binding));
    const secret = newTotpSecret();
    await this.challenges.setMfaPending(mfaChallenge, encodePending(this.secretBox.seal(secret, aadOf(binding.companyId, binding.userId))));
    return { secret, ...(await totpEnrollmentArtifacts(secret, user.phone)) };
  }

  /** Confirms the pending secret with a first valid code, stores it, returns tokens + one-time recovery codes. Revokes every other session. */
  async confirmEnroll(dto: MfaEnrollConfirmDto, meta: RequestMeta): Promise<MfaSession> {
    await this.throttleIp(meta);
    const binding = await this.challenges.readMfa(dto.mfaChallenge, 'mfa_enroll');
    await this.assertUserNotLimited(binding.userId);
    await this.reserveAttempt(binding.userId, dto.mfaChallenge);
    const pending = await this.challenges.getMfaPending(dto.mfaChallenge);
    if (!pending) throw new MfaChallengeInvalidException();
    const aad = aadOf(binding.companyId, binding.userId);
    const secret = this.secretBox.open(decodePending(pending), aad);
    const step = await checkTotp(secret, dto.code, -1);
    if (step === null) return this.rejectCode(binding, dto.mfaChallenge, meta);

    await this.challenges.consumeMfa(dto.mfaChallenge, 'mfa_enroll'); // exactly one concurrent confirm wins
    const codes = await generateRecoveryCodes();
    const sealed = this.secretBox.seal(secret, aad);
    const session = await this.tenantPrisma.run(binding.companyId, async (tx) => {
      const user = await this.findActiveUser(tx, binding);
      const current = await findConfirmedMfa(tx, binding.userId);
      if ((current?.id ?? null) !== binding.replacesMfaId) throw new MfaChallengeInvalidException(); // MFA changed since the challenge was issued
      await tx.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.userMfaRecoveryCode.deleteMany({ where: { userId: user.id } });
      await tx.userMfa.deleteMany({ where: { userId: user.id } });
      const mfa = await tx.userMfa.create({
        data: {
          companyId: user.companyId,
          userId: user.id,
          secretCiphertext: new Uint8Array(sealed.ciphertext),
          secretIv: new Uint8Array(sealed.iv),
          secretTag: new Uint8Array(sealed.tag),
          keyVersion: sealed.keyVersion,
          confirmedAt: new Date(),
          lastUsedStep: BigInt(step),
        },
      });
      await tx.userMfaRecoveryCode.createMany({ data: codes.hashes.map((codeHash) => ({ companyId: user.companyId, userId: user.id, codeHash })) });
      return this.auth.issueTokensInTx(tx, user, meta, undefined, 'auth.mfa.enrolled', mfa.id);
    });
    await this.rateLimiter.recordSuccess(this.limiterKey(binding.userId));
    return { ...session, recoveryCodes: codes.plain };
  }

  /** Second login step: a TOTP code or a single-use recovery code. */
  async verify(dto: MfaVerifyDto, meta: RequestMeta): Promise<MfaSession> {
    await this.throttleIp(meta);
    if ((dto.code === undefined) === (dto.recoveryCode === undefined)) throw new MfaCodeInvalidException();
    const binding = await this.challenges.readMfa(dto.mfaChallenge, 'mfa_verify');
    await this.assertUserNotLimited(binding.userId);
    await this.reserveAttempt(binding.userId, dto.mfaChallenge);
    const recoveryId = dto.recoveryCode !== undefined ? await this.matchRecoveryCode(binding, dto.recoveryCode) : undefined;

    const outcome = await this.tenantPrisma.run(binding.companyId, async (tx) => {
      const user = await this.findActiveUser(tx, binding);
      const mfa = await findConfirmedMfa(tx, user.id);
      if (!mfa) throw new MfaChallengeInvalidException();
      const viaRecovery = dto.recoveryCode !== undefined;
      const accepted = viaRecovery ? await this.claimRecoveryCode(tx, user.id, recoveryId) : await this.claimTotp(tx, mfa, user, dto.code!);
      if (!accepted) return undefined;
      await this.challenges.consumeMfa(dto.mfaChallenge, 'mfa_verify'); // single-use; also rolls the claim back if already consumed
      return this.auth.issueTokensInTx(tx, user, meta, undefined, viaRecovery ? 'auth.mfa.recovery_used' : 'auth.mfa.verified', mfa.id);
    });
    if (!outcome) return this.rejectCode(binding, dto.mfaChallenge, meta);
    await this.rateLimiter.recordSuccess(this.limiterKey(binding.userId));
    return outcome;
  }

  // ---- authenticated self-service ---------------------------------------

  /** Re-verifies password + current TOTP, then hands out an enroll challenge. The old MFA stays valid until the new one is confirmed. */
  async startReenroll(actor: AuthenticatedUser, dto: MfaReenrollDto, meta: RequestMeta): Promise<MfaStepRequired> {
    await this.assertUserNotLimited(actor.id);
    await this.reserveAttempt(actor.id);
    const mfaId = await this.tenantPrisma.run(actor.companyId, async (tx) => {
      const user = await tx.user.findUnique({ where: { id: actor.id } });
      const mfa = await findConfirmedMfa(tx, actor.id);
      if (!user?.passwordHash || !mfa) return undefined;
      if (!(await argon2.verify(user.passwordHash, dto.password))) return undefined;
      if (!(await this.claimTotp(tx, mfa, actor, dto.code))) return undefined;
      await this.audit(tx, actor, 'auth.mfa.reenroll', meta, { stage: 'requested' });
      return mfa.id;
    });
    if (!mfaId) return this.rejectCode({ userId: actor.id, companyId: actor.companyId }, undefined, meta);
    await this.rateLimiter.recordSuccess(this.limiterKey(actor.id));
    const mfaChallenge = await this.challenges.issueMfa({ scope: 'mfa_enroll', userId: actor.id, companyId: actor.companyId, replacesMfaId: mfaId });
    return { mfa: 'enroll', mfaChallenge, expiresIn: CHALLENGE_TTL_SECONDS };
  }

  /** New set of recovery codes (needs a fresh TOTP); the previous set is deleted. */
  async regenerateRecoveryCodes(actor: AuthenticatedUser, dto: RegenerateRecoveryCodesDto, meta: RequestMeta): Promise<{ recoveryCodes: string[] }> {
    await this.assertUserNotLimited(actor.id);
    await this.reserveAttempt(actor.id);
    let codes: Awaited<ReturnType<typeof generateRecoveryCodes>> | undefined;
    const ok = await this.tenantPrisma.run(actor.companyId, async (tx) => {
      const mfa = await findConfirmedMfa(tx, actor.id);
      if (!mfa || !(await this.claimTotp(tx, mfa, actor, dto.code))) return false;
      const fresh = (codes = await generateRecoveryCodes()); // only after the TOTP claim succeeded
      await tx.userMfaRecoveryCode.deleteMany({ where: { userId: actor.id } });
      await tx.userMfaRecoveryCode.createMany({ data: fresh.hashes.map((codeHash) => ({ companyId: actor.companyId, userId: actor.id, codeHash })) });
      await this.audit(tx, actor, 'auth.mfa.recovery_regenerated', meta);
      return true;
    });
    if (!ok) return this.rejectCode({ userId: actor.id, companyId: actor.companyId }, undefined, meta);
    await this.rateLimiter.recordSuccess(this.limiterKey(actor.id));
    return { recoveryCodes: codes!.plain };
  }

  // ---- internals ---------------------------------------------------------

  private async findActiveUser(tx: TenantClient, binding: Pick<MfaBinding, 'userId' | 'companyId'>) {
    const user = await tx.user.findFirst({
      where: { id: binding.userId, companyId: binding.companyId, isActive: true, company: { isActive: true } },
      select: { id: true, companyId: true, firstName: true, lastName: true, isActive: true, phone: true },
    });
    if (!user) throw new MfaChallengeInvalidException();
    return user;
  }

  /** Verifies the code against the stored secret, then wins the atomic `lastUsedStep < step` UPDATE (0 rows => replay/race => reject). */
  private async claimTotp(tx: TenantClient, mfa: MfaRow, user: { id: string; companyId: string }, code: string): Promise<boolean> {
    const secret = this.secretBox.open(toSealed(mfa), aadOf(user.companyId, user.id));
    const step = await checkTotp(secret, code, Number(mfa.lastUsedStep));
    if (step === null) return false;
    const claimed = await tx.userMfa.updateMany({ where: { id: mfa.id, lastUsedStep: { lt: BigInt(step) } }, data: { lastUsedStep: BigInt(step) } });
    return claimed.count === 1;
  }

  /** argon2 matching runs outside any DB transaction; returns the matching unused code id. */
  private async matchRecoveryCode(binding: Pick<MfaBinding, 'userId' | 'companyId'>, input: string): Promise<string | undefined> {
    const rows = await this.tenantPrisma.run(binding.companyId, (tx) => tx.userMfaRecoveryCode.findMany({ where: { userId: binding.userId, usedAt: null } }));
    return (await findMatchingRecoveryCode(rows, input))?.id;
  }

  /** Single-use: the conditional `usedAt IS NULL` update must affect exactly one row. */
  private async claimRecoveryCode(tx: TenantClient, userId: string, codeId: string | undefined): Promise<boolean> {
    if (!codeId) return false;
    const claimed = await tx.userMfaRecoveryCode.updateMany({ where: { id: codeId, userId, usedAt: null }, data: { usedAt: new Date() } });
    return claimed.count === 1;
  }

  /** Wrong code (attempt already reserved by reserveAttempt): burn the challenge once exhausted, audit (never the code), answer MFA_CODE_INVALID. */
  private async rejectCode(subject: Pick<MfaBinding, 'userId' | 'companyId'>, challengeId: string | undefined, meta: RequestMeta): Promise<never> {
    if (challengeId) await this.challenges.failMfaAttempt(challengeId);
    await this.tenantPrisma.run(subject.companyId, (tx) => this.audit(tx, { id: subject.userId, companyId: subject.companyId }, 'auth.mfa.failed', meta));
    throw new MfaCodeInvalidException();
  }

  private audit(tx: TenantClient, actor: { id: string; companyId: string }, action: string, meta: RequestMeta, newValue?: Record<string, string>) {
    return this.auditLog.log(tx, { companyId: actor.companyId, userId: actor.id, action, entity: 'User', entityId: actor.id, newValue, ip: meta.ip });
  }

  /** Atomically reserves an attempt on the per-user counter (and the challenge's) BEFORE the code is checked. */
  private async reserveAttempt(userId: string, challengeId?: string): Promise<void> {
    await this.translateLimits(async () => {
      if (challengeId) await this.challenges.reserveMfaAttempt(challengeId);
      await this.rateLimiter.reserveAttempt(this.limiterKey(userId));
    });
  }

  private limiterKey(userId: string): string {
    return `mfa:${userId}`;
  }

  private throttleIp(meta: RequestMeta): Promise<void> {
    return this.translateLimits(() => this.challenges.hit('mfa-ip', meta.ip ?? 'unknown', IP_MAX_PER_WINDOW, IP_WINDOW_SECONDS));
  }

  private assertUserNotLimited(userId: string): Promise<void> {
    return this.translateLimits(() => this.rateLimiter.assertNotBlocked(this.limiterKey(userId)));
  }

  /** Maps generic limiter/Redis errors to the MFA error contract. */
  private async translateLimits(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      if (err instanceof AuthChallengeRateLimitedException || err instanceof TooManyLoginAttemptsException) {
        throw new MfaRateLimitedException((err.getResponse() as { details: { retryAfterSeconds: number } }).details.retryAfterSeconds);
      }
      if (err instanceof ServiceUnavailableAppException) throw new MfaServiceUnavailableException();
      throw err;
    }
  }
}
