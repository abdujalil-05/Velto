import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import argon2 from 'argon2';
import request from 'supertest';
import { parsePermissionKey, prisma, systemPrisma } from '@velto/database';
import { permissionKeysForRole } from '../../../packages/database/src/rbac-catalog';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { uniquePhone } from './unique-phone';
import { loginWithMfa } from './mfa-login';

/** ADR-061b: GET /stock/movements needs `stock.movements.read` (not SALES_AGENT); agent keeps stock levels. */
describe('E2E ADR-061b: stock movements journal RBAC', () => {
  let app: INestApplication;
  const tenantPrisma = new TenantPrismaService();
  const password = 'CorrectHorseBattery9'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password
  const tokens: Record<string, { token: string; userId: string }> = {};
  let companyId: string;
  let otherCompanyId: string;
  let productId: string;
  let warehouseId: string;

  const seedCompany = async (label: string) => {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, name: label } });
    return (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: `${label} Co` } })).id;
  };
  const seedStock = (cid: string, tag: string) =>
    tenantPrisma.run(cid, async (tx) => {
      const product = await tx.product.create({ data: { companyId: cid, sku: `MV-${tag}-${Date.now()}`, name: `Mv ${tag}`, baseUnit: 'dona' } });
      const wh = await tx.warehouse.create({ data: { companyId: cid, name: `WH ${tag}` } });
      await tx.stockLevel.create({ data: { productId: product.id, warehouseId: wh.id, onHand: '5' } });
      await tx.stockMovement.create({ data: { companyId: cid, productId: product.id, warehouseId: wh.id, type: 'RECEIVE', qty: '5', note: tag } });
      return { productId: product.id, warehouseId: wh.id };
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, ['http://localhost:3000']);
    await app.listen(0, '127.0.0.1');

    companyId = await seedCompany('MVRBAC');
    otherCompanyId = await seedCompany('MVRBAC-OTHER');
    ({ productId, warehouseId } = await seedStock(companyId, 'own'));
    await seedStock(otherCompanyId, 'foreign');

    for (const roleCode of ['SALES_AGENT', 'SALES_DIRECTOR', 'WAREHOUSE']) {
      const permissionIds: string[] = [];
      for (const key of permissionKeysForRole(roleCode)) {
        const { module, code } = parsePermissionKey(key);
        const p = await systemPrisma.permission.upsert({ where: { module_code: { module, code } }, update: {}, create: { module, code } });
        permissionIds.push(p.id);
      }
      const phone = uniquePhone();
      const user = await systemPrisma.user.create({
        data: { companyId, firstName: roleCode, lastName: 'Mv', phone, passwordHash: await argon2.hash(password, { type: argon2.argon2id }) },
      });
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
        const role = await tx.role.create({ data: { companyId, code: roleCode, name: roleCode, isSystem: true } });
        for (const permissionId of permissionIds) await tx.rolePermission.create({ data: { roleId: role.id, permissionId } });
        await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
      });
      tokens[roleCode] = { token: (await loginWithMfa(app, phone, password)) .accessToken, userId: user.id };
    }
  });

  afterAll(async () => {
    await app.close();
  });

  const get = (path: string, role: string) => request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${tokens[role]!.token}`);

  it('SALES_AGENT GET /stock/movements => 403 + auth.permission_denied audit', async () => {
    const traceId = `trace-mv-${randomUUID()}`;
    await get('/stock/movements', 'SALES_AGENT').set('x-request-id', traceId).expect(403);
    const rows = await tenantPrisma.run(companyId, (tx) => tx.auditLog.findMany({ where: { action: 'auth.permission_denied', traceId } }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.newValue).toMatchObject({ permission: 'stock.movements.read' });
  });

  it.each(['SALES_DIRECTOR', 'WAREHOUSE'])('%s GET /stock/movements => 200, own tenant only', async (role) => {
    const res = await get('/stock/movements', role).expect(200);
    const items: Array<{ note?: string | null; productId: string }> = res.body.items ?? res.body.data ?? res.body;
    expect(items.some((m) => m.productId === productId)).toBe(true);
    expect(items.some((m) => m.note === 'foreign')).toBe(false);
  });

  it('SALES_AGENT keeps GET /stock and /sync/pull availability, no movement rows', async () => {
    const stock = await get('/stock', 'SALES_AGENT').expect(200);
    expect(JSON.stringify(stock.body)).toContain(productId);
    const pull = await get('/sync/pull', 'SALES_AGENT').expect(200);
    expect(pull.body.stock.some((s: { productId: string; warehouseId: string }) => s.productId === productId && s.warehouseId === warehouseId)).toBe(true);
    expect(pull.body.stockMovements).toBeUndefined();
  });
});
