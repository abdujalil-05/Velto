import { prisma, systemPrisma } from '@velto/database';

/**
 * Test-only: gives `userId` a DB role `code` carrying `permissionKeys`
 * ("module.action"), so code that re-reads permissions from the DB per
 * document (sync push, §8.4) sees what the test's AuthenticatedUser claims.
 */
export async function grantRole(companyId: string, userId: string, code: string, permissionKeys: string[]): Promise<string> {
  const permissionIds: string[] = [];
  for (const key of permissionKeys) {
    const [module, action] = key.split('.') as [string, string];
    const perm = await systemPrisma.permission.upsert({ where: { module_code: { module, code: action } }, update: {}, create: { module, code: action } });
    permissionIds.push(perm.id);
  }
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
    const role =
      (await tx.role.findFirst({ where: { companyId, code } })) ?? (await tx.role.create({ data: { companyId, code, name: code } }));
    for (const permissionId of permissionIds) {
      const has = await tx.rolePermission.findFirst({ where: { roleId: role.id, permissionId } });
      if (!has) await tx.rolePermission.create({ data: { roleId: role.id, permissionId } });
    }
    await tx.userRole.create({ data: { userId, roleId: role.id } });
    return role.id;
  });
}
