import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import argon2 from 'argon2';
import request from 'supertest';
import { prisma, systemPrisma } from '@velto/database';
import { permissionKeysForRole } from '../../../packages/database/src/rbac-catalog';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { uniquePhone } from './unique-phone';

/** F2.4 / SEC-023: a courier-only session delivers only its own orders, and only in full (partial `lines` => 403). */
describe('E2E: courier delivery — own order, full only', () => {
  let app: INestApplication;
  let companyId: string;
  let productId: string;
  let packagingId: string;
  let customerId: string;
  const tenantPrisma = new TenantPrismaService();
  const password = 'CorrectHorseBattery9'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password
  const tokens: Record<string, { token: string; userId: string }> = {};
  const auth = (k: string) => ({ Authorization: `Bearer ${tokens[k]!.token}` });
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, ['http://localhost:3000']);
    await app.init();

    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-fcd-${Date.now()}`, name: 'FCD' } });
    companyId = (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'FCD Co' } })).id;
    const roleIds: Record<string, string> = {};
    for (const roleCode of ['OWNER', 'COURIER']) {
      const permissionIds: string[] = [];
      for (const key of permissionKeysForRole(roleCode)) {
        const [module, code] = key.split('.');
        const p = await systemPrisma.permission.upsert({ where: { module_code: { module, code } }, update: {}, create: { module, code } });
        permissionIds.push(p.id);
      }
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
        const role = await tx.role.create({ data: { companyId, code: roleCode, name: roleCode, isSystem: true } });
        for (const permissionId of permissionIds) await tx.rolePermission.create({ data: { roleId: role.id, permissionId } });
        roleIds[roleCode] = role.id;
      });
    }
    for (const [key, roleCode] of [['OWNER', 'OWNER'], ['COURIER1', 'COURIER'], ['COURIER2', 'COURIER']] as const) {
      const phone = uniquePhone();
      const user = await systemPrisma.user.create({
        data: { companyId, firstName: key, lastName: 'Fcd', phone, passwordHash: await argon2.hash(password, { type: argon2.argon2id }) },
      });
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
        await tx.userRole.create({ data: { userId: user.id, roleId: roleIds[roleCode]! } });
      });
      const res = await http().post('/auth/login').send({ phone, password }).expect(201);
      tokens[key] = { token: res.body.accessToken, userId: user.id };
    }
    await tenantPrisma.run(companyId, async (tx) => {
      const warehouse = await tx.warehouse.create({ data: { companyId, name: 'W' } });
      const product = await tx.product.create({ data: { companyId, sku: 'FCD-1', name: 'P', baseUnit: 'dona', vatRate: '12' } });
      productId = product.id;
      packagingId = (await tx.productPackaging.create({ data: { productId, name: 'dona', qtyInBaseUnit: '1', isDefault: true } })).id;
      const pl = await tx.priceList.create({ data: { companyId, name: 'PL', isDefault: true } });
      await tx.priceListItem.create({ data: { priceListId: pl.id, productId, price: '10000.00' } });
      await tx.stockLevel.create({ data: { productId, warehouseId: warehouse.id, onHand: '1000', reserved: '0' } });
      customerId = (await tx.customer.create({ data: { companyId, code: `FCD-${Date.now()}`, name: 'C' } })).id;
    });
  });

  afterAll(async () => {
    await app.close();
  });

  /** Confirmed order (qty 4, one line) assigned to the given courier. */
  async function confirmedOrderFor(courierKey: string) {
    const created = await http().post('/orders').set(auth('OWNER')).send({ customerId, lines: [{ productId, packagingId, qty: 4 }] }).expect(201);
    await http().post(`/orders/${created.body.id}/confirm`).set(auth('OWNER')).expect(201);
    await tenantPrisma.run(companyId, (tx) => tx.salesOrder.update({ where: { id: created.body.id }, data: { courierId: tokens[courierKey]!.userId } }));
    return { id: created.body.id as string, lineId: created.body.lines[0].id as string };
  }
  const orderStatus = (id: string) => tenantPrisma.run(companyId, async (tx) => (await tx.salesOrder.findUniqueOrThrow({ where: { id } })).status);

  it('courier delivering with partial `lines` => 403 SALES_PARTIAL_DELIVERY_NOT_ALLOWED; nothing changes; later full delivery works', async () => {
    const o = await confirmedOrderFor('COURIER1');
    const res = await http().post(`/orders/${o.id}/deliver`).set(auth('COURIER1')).send({ lines: [{ lineId: o.lineId, deliveredQty: '2' }] }).expect(403);
    expect(res.body.code).toBe('SALES_PARTIAL_DELIVERY_NOT_ALLOWED');
    expect(await orderStatus(o.id)).toBe('CONFIRMED');
    const full = await http().post(`/orders/${o.id}/deliver`).set(auth('COURIER1')).expect(201);
    expect(full.body.status).toBe('DELIVERED');
  });

  it('courier: even a "full" explicit lines array is refused (courier path is body-less full delivery only)', async () => {
    const o = await confirmedOrderFor('COURIER1');
    await http().post(`/orders/${o.id}/deliver`).set(auth('COURIER1')).send({ lines: [{ lineId: o.lineId, deliveredQty: '4' }] }).expect(403);
    expect(await orderStatus(o.id)).toBe('CONFIRMED');
  });

  it('courier cannot deliver an order assigned to another courier (SEC-023)', async () => {
    const o = await confirmedOrderFor('COURIER2');
    await http().post(`/orders/${o.id}/deliver`).set(auth('COURIER1')).expect(403);
    expect(await orderStatus(o.id)).toBe('CONFIRMED');
  });

  it('courier cannot GET /routes (no routes.read)', async () => {
    await http().get('/routes').set(auth('COURIER1')).expect(403);
  });

  it('control: OWNER may deliver partially (lines) — the restriction is courier-specific', async () => {
    const o = await confirmedOrderFor('COURIER1');
    const res = await http().post(`/orders/${o.id}/deliver`).set(auth('OWNER')).send({ lines: [{ lineId: o.lineId, deliveredQty: '3' }] }).expect(201);
    expect(res.body.status).toBe('DELIVERED');
  });
});
