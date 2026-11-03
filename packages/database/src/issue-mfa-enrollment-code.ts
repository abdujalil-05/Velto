// ADR-058 follow-up: platform issuance of a one-time MFA enrollment code. A
// privileged user without a confirmed TOTP must present this out-of-band code
// for their FIRST enrollment, so a stolen password alone cannot bind an
// attacker's authenticator. Invalidates (marks used) the user's previous
// unused codes, stores only the sha256, expires in 1h, writes an
// `auth.mfa.enrollment_code_issued` AuditLog row (never the code itself) and
// prints the code once to stdout.
//
// `systemPrisma` (BYPASSRLS) is used only to resolve that the user belongs to
// the given company; every write then runs inside `withTenant(companyId)`.
//
// Run:
//   pnpm --filter @velto/database exec tsx src/issue-mfa-enrollment-code.ts <companyId> <userId> <reason> <operatorName>
// Against production (nothing is written without the explicit opt-in):
//   NODE_ENV=production ALLOW_PRODUCTION_MFA_ENROLLMENT_CODE=1 pnpm --filter @velto/database exec tsx src/issue-mfa-enrollment-code.ts ...
import { systemPrisma, withTenant } from './client';
import { issueMfaEnrollmentCodeInTx, type IssueMfaEnrollmentCodeResult } from './mfa-enrollment-code';

export type { IssueMfaEnrollmentCodeResult };
export type IssueMfaEnrollmentCodeArgs = { companyId: string; userId: string; reason: string; operatorName: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USAGE = 'Usage: issue-mfa-enrollment-code.ts <companyId> <userId> <reason> <operatorName>';

/** Fails closed: every argument is mandatory, ids must be UUIDs, reason/operator non-blank. */
export function parseIssueMfaEnrollmentCodeArgs(argv: readonly string[]): IssueMfaEnrollmentCodeArgs {
  const [companyId, userId, reason, operatorName] = argv.map((a) => a?.trim() ?? '');
  if (!companyId || !userId || !reason || !operatorName || argv.length !== 4) {
    throw new Error(`Refusing to run: all four arguments are required. ${USAGE}`);
  }
  if (!UUID_RE.test(companyId) || !UUID_RE.test(userId)) {
    throw new Error(`Refusing to run: companyId and userId must be UUIDs. ${USAGE}`);
  }
  return { companyId, userId, reason, operatorName };
}

export async function issueMfaEnrollmentCode(args: IssueMfaEnrollmentCodeArgs): Promise<IssueMfaEnrollmentCodeResult> {
  const { companyId, userId, reason, operatorName } = parseIssueMfaEnrollmentCodeArgs([
    args.companyId,
    args.userId,
    args.reason,
    args.operatorName,
  ]);

  // Resolve only — cross-tenant read, no write on the BYPASSRLS client.
  const user = await systemPrisma.user.findFirst({ where: { id: userId, companyId }, select: { id: true } });
  if (!user) throw new Error(`User ${userId} not found in company ${companyId}`);

  return withTenant(companyId, (tx) =>
    issueMfaEnrollmentCodeInTx(tx, { companyId, userId, createdById: null, auditNewValue: { operatorName, reason } }),
  );
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PRODUCTION_MFA_ENROLLMENT_CODE !== '1') {
    throw new Error('Refusing to run: NODE_ENV=production. Re-run with ALLOW_PRODUCTION_MFA_ENROLLMENT_CODE=1 once reviewed.');
  }
  const { code, ...rest } = await issueMfaEnrollmentCode(parseIssueMfaEnrollmentCodeArgs(process.argv.slice(2)));
  console.log(JSON.stringify(rest));
  console.log(`MFA enrollment code (shown once, valid 1h): ${code}`);
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => systemPrisma.$disconnect());
}
