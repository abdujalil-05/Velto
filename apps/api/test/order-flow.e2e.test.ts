import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import argon2 from 'argon2';
import request from 'supertest';
import { prisma, systemPrisma } from '@velto/database';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';

/**
 * 16 / 11.4: a real end-to-end run of the MVP's core acceptance scenario —
 * "agent do'konda buyurtma oladi → ofisda darhol ko'rinadi → ombor beradi →
 * to'lov qabul qilinadi → qarz kuzatiladi" (§5.1) — driven entirely over
 * HTTP through the actual Nest application (JwtAuthGuard,
 * TenantContextInterceptor's fresh permission load, ValidationPipe,
 * AllExceptionsFilter), unlike every other *.test.ts in this repo, which
 * calls service methods directly and never exercises that pipeline. Fixture
 * data (tenant/company/warehouse/product/customer/role) is still seeded
 * directly via Prisma, same as the service-level tests — only the flow
 * actually under test goes through HTTP.
 */
describe('E2E: order → confirm → deliver → payment → balance (real HTTP)', () => {
  let app: INestApplication;
  let companyId: string;
  let accessToken: string;
  let customerId: string;
  let productId: string;
  let packagingId: string;
  const phone = `+99890${Math.floor(1_000_000 + Math.random() * 8_000_000)}`;
  // Test-fixture password for a throwaway user this file creates itself —
  // not a real credential.
  const password = 'CorrectHorseBattery9'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, ['http://localhost:3000']);
    await app.init();

    const tenant = await systemPrisma.tenant.create({
      data: { slug: `test-e2e-${Date.now()}`, name: 'E2E Test Tenant' },
    });
    const company = await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'E2E Test Co' } });
    companyId = company.id;

    const permissionCodes = [
      { module: 'orders', code: 'create' },
      { module: 'orders', code: 'read' },
      { module: 'orders', code: 'update' },
      // Separate from 'update' since couriers hold only this one — the E2E
      // operator stands in for a warehouse user, who holds both.
      { module: 'orders', code: 'deliver' },
      { module: 'payments', code: 'create' },
      { module: 'payments', code: 'read' },
      { module: 'customers', code: 'read' },
    ];
    const permissions = await Promise.all(
      permissionCodes.map((p) =>
        systemPrisma.permission.upsert({
          where: { module_code: { module: p.module, code: p.code } },
          update: {},
          create: p,
        }),
      ),
    );

    const dbUser = await systemPrisma.user.create({
      data: { companyId, firstName: 'E2E', lastName: 'Operator', phone, passwordHash: await argon2.hash(password, { type: argon2.argon2id }) },
    });

    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
      const role = await tx.role.create({ data: { companyId, code: 'E2E_OPERATOR', name: 'E2E Operator' } });
      await tx.rolePermission.createMany({
        data: permissions.map((p) => ({ roleId: role.id, permissionId: p.id })),
      });
      await tx.userRole.create({ data: { userId: dbUser.id, roleId: role.id } });

      const warehouse = await tx.warehouse.create({ data: { companyId, name: 'E2E Warehouse' } });
      const product = await tx.product.create({
        data: { companyId, sku: 'E2E-SKU-1', name: 'E2E Product', baseUnit: 'dona', vatRate: '12' },
      });
      productId = product.id;
      const packaging = await tx.productPackaging.create({
        data: { productId: product.id, name: 'dona', qtyInBaseUnit: '1', isDefault: true },
      });
      packagingId = packaging.id;
      const priceList = await tx.priceList.create({ data: { companyId, name: 'E2E Price List', isDefault: true } });
      await tx.priceListItem.create({ data: { priceListId: priceList.id, productId: product.id, price: '10000.00' } });
      await tx.stockLevel.create({ data: { productId: product.id, warehouseId: warehouse.id, onHand: '100', reserved: '0' } });
      const customer = await tx.customer.create({
        data: { companyId, code: 'E2E-CUST-1', name: 'E2E Customer' },
      });
      customerId = customer.id;
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('logs in over HTTP and receives a bearer token', async () => {
    const res = await request(app.getHttpServer()).post('/auth/login').send({ phone, password }).expect(201);
    expect(res.body.accessToken).toBeTruthy();
    accessToken = res.body.accessToken;
  });

  it('rejects the same request without a token (JwtAuthGuard is actually wired)', async () => {
    await request(app.getHttpServer()).get('/orders').expect(401);
  });

  let orderId: string;

  it('creates an order over HTTP with a server-computed total', async () => {
    const res = await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ customerId, lines: [{ productId, packagingId, qty: 5 }] })
      .expect(201);

    expect(res.body.status).toBe('SUBMITTED');
    // 5 * 10000 * 1.12 VAT — client never sends a price (8.2).
    expect(res.body.total).toBe('56000');
    orderId = res.body.id;
  });

  it('confirms and delivers the order over HTTP, creating an invoice', async () => {
    const confirmed = await request(app.getHttpServer())
      .post(`/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(201);
    expect(confirmed.body.status).toBe('CONFIRMED');

    const delivered = await request(app.getHttpServer())
      .post(`/orders/${orderId}/deliver`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(201);
    expect(delivered.body.status).toBe('DELIVERED');
  });

  it('reflects the delivered order as customer debt', async () => {
    const res = await request(app.getHttpServer())
      .get(`/customers/${customerId}/balance`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.balance).toBe('56000');
  });

  it('accepts a partial payment over HTTP and reduces the balance (8.4 FIFO)', async () => {
    await request(app.getHttpServer())
      .post('/payments')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ customerId, amount: 20000, method: 'CASH' })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get(`/customers/${customerId}/balance`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.balance).toBe('36000');
  });

  it('rejects a client-supplied price override — DTO whitelist strips unknown fields (SEC-040..048)', async () => {
    const res = await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ customerId, lines: [{ productId, packagingId, qty: 1, unitPrice: 1 }] })
      .expect(400);
    expect(res.body.code).toBeTruthy();
  });
});
