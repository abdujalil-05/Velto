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

const PERMISSION_DEFS: { module: string; actions: string[] }[] = [
  { module: 'customers', actions: ['read', 'create', 'update', 'delete'] },
  { module: 'catalog', actions: ['read', 'create', 'update', 'delete'] },
  { module: 'stock', actions: ['read', 'receive', 'adjust'] },
  { module: 'orders', actions: ['read', 'create', 'update', 'cancel'] },
  { module: 'invoices', actions: ['read'] },
  { module: 'payments', actions: ['read', 'create'] },
  { module: 'cash', actions: ['read', 'open', 'close'] },
  { module: 'routes', actions: ['read', 'create', 'update'] },
  { module: 'field', actions: ['read', 'create'] },
  { module: 'purchases', actions: ['read', 'create', 'update', 'receive'] },
  { module: 'reports', actions: ['read', 'export'] },
  { module: 'users', actions: ['read', 'create', 'update'] },
  { module: 'roles', actions: ['read'] },
  { module: 'audit', actions: ['read'] },
  { module: 'settings', actions: ['read', 'update'] },
  { module: 'integrations', actions: ['export1c'] },
];

// Keep in sync with SYSTEM_ROLES in seed.ts (4.1, post-simplification: 6 roles).
const SYSTEM_ROLES = [
  { code: 'OWNER', name: 'Admin' },
  { code: 'SALES_DIRECTOR', name: 'Director' },
  { code: 'SALES_AGENT', name: 'Agent' },
  { code: 'WAREHOUSE', name: 'Omborchi' },
  { code: 'CASHIER', name: 'Kassir' },
  { code: 'ACCOUNTANT', name: 'Buxgalter' },
];

// Keep in sync with ROLE_PERMISSIONS in seed.ts. Roles are fixed system
// roles with no custom-role authoring in MVP (roles.service.ts) — a real
// tenant provisioned here has no later way to grant these, so every
// non-OWNER role must come out of this script already usable, not just
// created as an empty shell.
const ROLE_PERMISSIONS: Record<string, string[] | 'ALL'> = {
  OWNER: 'ALL',
  SALES_DIRECTOR: [
    'customers.read', 'customers.update', 'catalog.read', 'stock.read',
    'orders.read', 'orders.update', 'invoices.read', 'payments.read',
    'routes.read', 'routes.create', 'routes.update', 'field.read',
    'reports.read', 'reports.export', 'users.read', 'users.create',
    'users.update', 'roles.read',
  ],
  SALES_AGENT: [
    'customers.read', 'catalog.read', 'stock.read', 'orders.read',
    'orders.create', 'payments.create', 'payments.read', 'invoices.read', 'routes.read', 'field.read', 'field.create',
  ],
  WAREHOUSE: [
    'catalog.read', 'stock.read', 'stock.receive', 'stock.adjust',
    'purchases.read', 'purchases.create', 'purchases.update', 'purchases.receive',
    'orders.read', 'orders.update', // marks CONFIRMED orders as DELIVERED
  ],
  CASHIER: [
    'customers.read', 'invoices.read', 'payments.read', 'payments.create',
    'cash.read', 'cash.open', 'cash.close',
  ],
  ACCOUNTANT: [
    'customers.read', 'invoices.read', 'payments.read', 'cash.read', 'reports.read',
    'reports.export', 'integrations.export1c',
  ],
};

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

  await withTenant(company.id, async (tx) => {
    const roleIdByCode: Record<string, string> = {};
    for (const def of SYSTEM_ROLES) {
      const role = await tx.role.create({
        data: { companyId: company.id, code: def.code, name: def.name, isSystem: true },
      });
      roleIdByCode[def.code] = role.id;
    }

    for (const [roleCode, roleId] of Object.entries(roleIdByCode)) {
      const grant = ROLE_PERMISSIONS[roleCode];
      const keys = grant === 'ALL' ? Object.keys(permissionIdByKey) : (grant ?? []);
      for (const key of keys) {
        const permissionId = permissionIdByKey[key];
        if (!permissionId) continue;
        await tx.rolePermission.create({ data: { roleId, permissionId } });
      }
    }

    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
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
