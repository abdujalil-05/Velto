// ADR-058 platform recovery: a user who lost both their authenticator and
// their recovery codes, and whose company has no OWNER able to use
// `users.mfa_reset` (e.g. the OWNER themself), is reset by a platform
// operator. Deletes the user's UserMfa + recovery codes (they re-enroll on
// next login), revokes every live refresh token of the user, and writes an
// `auth.mfa.reset` AuditLog row (actor = platform, operator, reason).
//
// `systemPrisma` (BYPASSRLS) is used only to resolve that the user belongs to
// the given company; every write then runs inside `withTenant(companyId)` so
// RLS still scopes it to that one tenant.
//
// Run:
//   pnpm --filter @velto/database exec tsx src/reset-user-mfa.ts <companyId> <userId> <reason> <operatorName>
// Against production (nothing is written without the explicit opt-in):
//   NODE_ENV=production ALLOW_PRODUCTION_MFA_RESET=1 pnpm --filter @velto/database exec tsx src/reset-user-mfa.ts ...
import { systemPrisma, withTenant } from './client';

export const MFA_RESET_AUDIT_ACTION = 'auth.mfa.reset';

export type ResetUserMfaArgs = { companyId: string; userId: string; reason: string; operatorName: string };

export type ResetUserMfaResult = {
  mfaDeleted: number;
  recoveryCodesDeleted: number;
  refreshTokensRevoked: number;
  auditLogId: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USAGE = 'Usage: reset-user-mfa.ts <companyId> <userId> <reason> <operatorName>';

/** Fails closed: every argument is mandatory, ids must be UUIDs, reason/operator non-blank. */
export function parseResetUserMfaArgs(argv: readonly string[]): ResetUserMfaArgs {
  const [companyId, userId, reason, operatorName] = argv.map((a) => a?.trim() ?? '');
  if (!companyId || !userId || !reason || !operatorName || argv.length !== 4) {
    throw new Error(`Refusing to run: all four arguments are required. ${USAGE}`);
  }
  if (!UUID_RE.test(companyId) || !UUID_RE.test(userId)) {
    throw new Error(`Refusing to run: companyId and userId must be UUIDs. ${USAGE}`);
  }
  return { companyId, userId, reason, operatorName };
}

export async function resetUserMfa(args: ResetUserMfaArgs): Promise<ResetUserMfaResult> {
  const { companyId, userId, reason, operatorName } = parseResetUserMfaArgs([
    args.companyId,
    args.userId,
    args.reason,
    args.operatorName,
  ]);

  // Resolve only — cross-tenant read, no write on the BYPASSRLS client.
  const user = await systemPrisma.user.findFirst({ where: { id: userId, companyId }, select: { id: true } });
  if (!user) throw new Error(`User ${userId} not found in company ${companyId}`);

  return withTenant(companyId, async (tx) => {
    const mfa = await tx.userMfa.findUnique({ where: { userId }, select: { id: true, confirmedAt: true } });
    const codes = await tx.userMfaRecoveryCode.deleteMany({ where: { companyId, userId } });
    const mfaDeleted = await tx.userMfa.deleteMany({ where: { companyId, userId } });
    const tokens = await tx.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    const audit = await tx.auditLog.create({
      data: {
        companyId,
        userId: null, // actor is the platform, not a tenant user
        action: MFA_RESET_AUDIT_ACTION,
        entity: 'User',
        entityId: userId,
        oldValue: { mfaId: mfa?.id ?? null, confirmed: mfa?.confirmedAt != null, recoveryCodes: codes.count },
        newValue: { actor: 'platform', operatorName, reason, refreshTokensRevoked: tokens.count },
      },
      select: { id: true },
    });
    return {
      mfaDeleted: mfaDeleted.count,
      recoveryCodesDeleted: codes.count,
      refreshTokensRevoked: tokens.count,
      auditLogId: audit.id,
    };
  });
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PRODUCTION_MFA_RESET !== '1') {
    throw new Error('Refusing to run: NODE_ENV=production. Re-run with ALLOW_PRODUCTION_MFA_RESET=1 once reviewed.');
  }
  const result = await resetUserMfa(parseResetUserMfaArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result));
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => systemPrisma.$disconnect());
}
