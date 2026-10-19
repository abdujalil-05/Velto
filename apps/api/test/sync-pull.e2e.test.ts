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

/** F4: BigInt changeSeq must serialize (decimal string) through the real HTTP stack, in /sync/pull and in plain CRUD responses. */
describe('E2E F4: BigInt changeSeq serialization + /sync/pull shape', () => {
  let app: INestApplication;
  let token = '';
  const password = 'CorrectHorseBattery9'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password
  const tenantPrisma = new TenantPrismaService();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, ['http://localhost:3000']);
    await app.init();

    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-f4pull-${Date.now()}`, name: 'F4 pull' } });
    const cid = (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'F4 pull' } })).id;
    const permissionIds: string[] = [];
    for (const key of permissionKeysForRole('OWNER')) {
      const [module, code] = key.split('.');
      permissionIds.push((await systemPrisma.permission.upsert({ where: { module_code: { module, code } }, update: {}, create: { module, code } })).id);
    }
    const phone = uniquePhone();
    const user = await systemPrisma.user.create({
      data: { companyId: cid, firstName: 'O', lastName: 'F4', phone, passwordHash: await argon2.hash(password, { type: argon2.argon2id }) },
    });
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company_id', ${cid}, true)`;
      const role = await tx.role.create({ data: { companyId: cid, code: 'OWNER', name: 'OWNER', isSystem: true } });
      for (const permissionId of permissionIds) await tx.rolePermission.create({ data: { roleId: role.id, permissionId } });
      await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
    });
    await tenantPrisma.run(cid, async (tx) => {
      await tx.product.create({ data: { companyId: cid, sku: 'E2E-1', name: 'E2E', baseUnit: 'dona', vatRate: 12 } });
      await tx.customer.create({ data: { companyId: cid, code: 'E2E-C', name: 'E2E C' } });
    });
    const res = await request(app.getHttpServer()).post('/auth/login').send({ phone, password }).expect(201);
    token = res.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  it('GET /sync/pull returns changeSeq as a decimal string, string cursor, hasMore, tombstones[]', async () => {
    const res = await request(app.getHttpServer()).get('/sync/pull?limit=100').set('Authorization', `Bearer ${token}`).expect(200);
    expect(typeof res.body.cursor).toBe('string');
    expect(res.body.hasMore).toBe(false);
    expect(Array.isArray(res.body.tombstones)).toBe(true);
    expect(res.body.products.length).toBeGreaterThan(0);
    expect(res.body.products[0].changeSeq).toMatch(/^\d+$/);
    expect(res.body.customers[0].changeSeq).toMatch(/^\d+$/);
    const again = await request(app.getHttpServer()).get(`/sync/pull?cursor=${res.body.cursor}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(again.body.fullResync).toBe(false);
  });

  it('a plain CRUD response carrying changeSeq no longer 500s and exposes it as a string', async () => {
    const res = await request(app.getHttpServer()).get('/customers').set('Authorization', `Bearer ${token}`).expect(200);
    const rows = res.body.items ?? res.body.data ?? res.body;
    expect(typeof rows[0].changeSeq).toBe('string');
  });
});
