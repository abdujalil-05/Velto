// One-off provisioning script for a fresh, empty database: creates a single
// Tenant + Company + OWNER user, nothing else. Everything past that (
// warehouse, catalog, customers) is meant to be created by the Owner
// themselves via the app's /onboarding wizard — there is no self-service
// signup flow yet (VELTO-TZ.md 4.1: tenant provisioning is a platform-admin,
// DB-level operation in MVP), so this fills that gap for local dev.
import 'dotenv/config';
import argon2 from 'argon2';
import crypto from 'node:crypto';
import { systemPrisma, withTenant } from './index';
// Role/permission catalog lives in one place only — see rbac-catalog.ts.
// Do not re-declare these lists here.
import { SYSTEM_ROLES, PERMISSION_DEFS, permissionKeysForRole } from './rbac-catalog';

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to run: NODE_ENV=production.');
  process.exit(1);
}

const COMPANY_NAME = process.argv[2] ?? 'Velto Distribution';
const OWNER_PHONE = process.argv[3] ?? '+998901234567';
const OWNER_FIRST_NAME = process.argv[4] ?? 'Owner';
const OWNER_LAST_NAME = process.argv[5] ?? 'Owner';

function generatePassword(): string {
  // 16 chars from a mixed alphabet — well past MinLength(10) and outside the
  // common-password denylist by construction.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%';
  return Array.from(crypto.randomFillSync(new Uint8Array(16)))
    .map((b) => alphabet[b % alphabet.length])
    .join('');
}

async function main() {
  const password = generatePassword();

  const tenant = await systemPrisma.tenant.create({
    data: {
      slug: `t-${crypto.randomUUID().slice(0, 8)}`,
      name: COMPANY_NAME,
      plan: 'START',
    },
  });

  const company = await systemPrisma.company.create({
    data: { tenantId: tenant.id, name: COMPANY_NAME },
  });

  const permissionIdByKey: Record<string, string> = {};
  for (const def of PERMISSION_DEFS) {
    for (const action of def.actions) {
      const permission = await systemPrisma.permission.upsert({
        where: { module_code: { module: def.module, code: action } },
        update: {},
        create: { module: def.module, code: action },
      });
      permissionIdByKey[`${def.module}.${action}`] = permission.id;
    }
  }

  // Hashed before the transaction opens — argon2id is intentionally slow
  // (~100ms+) and must not eat into the tenant transaction's time budget
  // while an RLS-scoped connection is held open.
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

  await withTenant(company.id, async (tx) => {
    const roleIdByCode: Record<string, string> = {};
    for (const def of SYSTEM_ROLES) {
      const role = await tx.role.create({
        data: { companyId: company.id, code: def.code, name: def.name, isSystem: true },
      });
      roleIdByCode[def.code] = role.id;
    }

    for (const [roleCode, roleId] of Object.entries(roleIdByCode)) {
      for (const key of permissionKeysForRole(roleCode)) {
        const permissionId = permissionIdByKey[key];
        if (!permissionId) continue;
        await tx.rolePermission.create({ data: { roleId, permissionId } });
      }
    }

    const owner = await tx.user.create({
      data: {
        companyId: company.id,
        firstName: OWNER_FIRST_NAME,
        lastName: OWNER_LAST_NAME,
        phone: OWNER_PHONE,
        passwordHash,
        isActive: true,
      },
    });
    await tx.userRole.create({ data: { userId: owner.id, roleId: roleIdByCode.OWNER! } });
  });

  console.log('Company yaratildi:', company.name, `(${company.id})`);
  console.log('Owner login:');
  console.log('  Telefon:', OWNER_PHONE);
  console.log('  Parol:  ', password);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => process.exit(0));
