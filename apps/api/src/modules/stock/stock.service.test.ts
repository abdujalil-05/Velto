import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, systemPrisma } from '@velto/database';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { InsufficientStockException, InvalidStockQtyException } from './stock-exceptions';
import { StockService } from './stock.service';

describe('StockService (integration, real Postgres + RLS)', () => {
  let companyId: string;
  let user: AuthenticatedUser;
  let warehouseId: string;
  let productId: string;

  const tenantPrisma = new TenantPrismaService();
  const auditLog = new AuditLogService();
  const stock = new StockService(tenantPrisma, auditLog);

  beforeAll(async () => {
    const tenant = await systemPrisma.tenant.create({
      data: { slug: `test-stock-${Date.now()}`, name: 'Stock Test Tenant' },
    });
    const company = await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Stock Test Co' } });
    companyId = company.id;

    const dbUser = await systemPrisma.user.create({
      data: { companyId, firstName: 'Test', lastName: 'User', phone: '+998900000002' },
    });
    user = { id: dbUser.id, companyId, firstName: 'Test', lastName: 'User', roles: [], permissions: [] };

    await tenantPrisma.run(companyId, async (tx) => {
      const warehouse = await tx.warehouse.create({ data: { companyId, name: 'Test Warehouse' } });
      warehouseId = warehouse.id;
      const product = await tx.product.create({
        data: { companyId, sku: 'STOCK-TEST-1', name: 'Stock Test Product', baseUnit: 'dona', vatRate: 12 },
      });
      productId = product.id;
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  it('receive() creates a StockLevel row on first use and increments onHand', async () => {
    const level = await tenantPrisma.run(companyId, () =>
      stock.receive({ productId, warehouseId, qty: 100, note: 'initial' }, user),
    );
    expect(level?.onHand.toString()).toBe('100');
    expect(level?.available.toString()).toBe('100');
  });

  it('adjust() applies a signed correction and refuses to take on-hand negative', async () => {
    const level = await tenantPrisma.run(companyId, () =>
      stock.adjust({ productId, warehouseId, qty: -20, reason: 'damaged stock' }, user),
    );
    expect(level?.onHand.toString()).toBe('80');

    await expect(
      tenantPrisma.run(companyId, () => stock.adjust({ productId, warehouseId, qty: -1000, reason: 'oops' }, user)),
    ).rejects.toBeInstanceOf(InvalidStockQtyException);
  });

  it('reserve() then issue() moves qty out of onHand and clears the reservation', async () => {
    await tenantPrisma.run(companyId, (tx) =>
      stock.reserve(tx, { companyId, productId, warehouseId, qty: 30, refType: 'Test', refId: productId }),
    );
    let level = await tenantPrisma.run(companyId, () => stock.list({ page: 1, pageSize: 100, productId, warehouseId }));
    expect(level.data[0]?.reserved.toString()).toBe('30');
    expect(level.data[0]?.available.toString()).toBe('50'); // 80 onHand - 30 reserved

    await tenantPrisma.run(companyId, (tx) =>
      stock.issue(tx, { companyId, productId, warehouseId, qty: 30, refType: 'Test', refId: productId }),
    );
    level = await tenantPrisma.run(companyId, () => stock.list({ page: 1, pageSize: 100, productId, warehouseId }));
    expect(level.data[0]?.onHand.toString()).toBe('50');
    expect(level.data[0]?.reserved.toString()).toBe('0');
  });

  it('reserve() rejects a request beyond what is available', async () => {
    await expect(
      tenantPrisma.run(companyId, (tx) =>
        stock.reserve(tx, { companyId, productId, warehouseId, qty: 10_000, refType: 'Test', refId: productId }),
      ),
    ).rejects.toBeInstanceOf(InsufficientStockException);
  });

  it('under concurrent reservation for the last units, exactly one request wins (row lock, no oversell)', async () => {
    // Fresh product/warehouse pair so this test doesn't depend on ordering
    // relative to the others above.
    const { raceProductId, raceWarehouseId } = await tenantPrisma.run(companyId, async (tx) => {
      const warehouse = await tx.warehouse.create({ data: { companyId, name: 'Race Warehouse' } });
      const product = await tx.product.create({
        data: { companyId, sku: 'STOCK-RACE-1', name: 'Race Product', baseUnit: 'dona', vatRate: 12 },
      });
      return { raceProductId: product.id, raceWarehouseId: warehouse.id };
    });
    await tenantPrisma.run(companyId, () =>
      stock.receive({ productId: raceProductId, warehouseId: raceWarehouseId, qty: 10 }, user),
    );

    // Two concurrent reservations of 6 each against 10 available — only one can win.
    const attempt = () =>
      tenantPrisma.run(companyId, (tx) =>
        stock.reserve(tx, {
          companyId,
          productId: raceProductId,
          warehouseId: raceWarehouseId,
          qty: 6,
          refType: 'Test',
          refId: raceProductId,
        }),
      );

    const results = await Promise.allSettled([attempt(), attempt()]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientStockException);

    const level = await tenantPrisma.run(companyId, () =>
      stock.list({ page: 1, pageSize: 100, productId: raceProductId, warehouseId: raceWarehouseId }),
    );
    // Reserved must be exactly 6, never 12 — the whole point of the row lock.
    expect(level.data[0]?.reserved.toString()).toBe('6');
  });

  it('adjust() refuses to take on-hand below what is already reserved for pending orders', async () => {
    const { pid, wid } = await tenantPrisma.run(companyId, async (tx) => {
      const warehouse = await tx.warehouse.create({ data: { companyId, name: 'Reserved Invariant Warehouse' } });
      const product = await tx.product.create({
        data: { companyId, sku: 'STOCK-RESV-1', name: 'Reserved Invariant Product', baseUnit: 'dona', vatRate: 12 },
      });
      return { pid: product.id, wid: warehouse.id };
    });
    await tenantPrisma.run(companyId, () => stock.receive({ productId: pid, warehouseId: wid, qty: 10 }, user));
    await tenantPrisma.run(companyId, (tx) =>
      stock.reserve(tx, { companyId, productId: pid, warehouseId: wid, qty: 10, refType: 'Test', refId: pid }),
    );

    // onHand=10, reserved=10 — any negative adjustment would take onHand below reserved.
    await expect(
      tenantPrisma.run(companyId, () => stock.adjust({ productId: pid, warehouseId: wid, qty: -1, reason: 'shrinkage' }, user)),
    ).rejects.toBeInstanceOf(InvalidStockQtyException);
  });

  it('issue() refuses to take on-hand negative even if reserved is inconsistently ahead of it', async () => {
    // adjust() now refuses to create an onHand < reserved state itself (test
    // above) — this crafts that state directly to prove issue() also
    // independently guards its own hard floor (onHand can never go negative),
    // rather than relying solely on adjust() to prevent it upstream.
    const { pid, wid } = await tenantPrisma.run(companyId, async (tx) => {
      const warehouse = await tx.warehouse.create({ data: { companyId, name: 'Issue Guard Warehouse' } });
      const product = await tx.product.create({
        data: { companyId, sku: 'STOCK-ISSUE-GUARD-1', name: 'Issue Guard Product', baseUnit: 'dona', vatRate: 12 },
      });
      await tx.stockLevel.create({ data: { productId: product.id, warehouseId: warehouse.id, onHand: 2, reserved: 5 } });
      return { pid: product.id, wid: warehouse.id };
    });

    await expect(
      tenantPrisma.run(companyId, (tx) =>
        stock.issue(tx, { companyId, productId: pid, warehouseId: wid, qty: 5, refType: 'Test', refId: pid }),
      ),
    ).rejects.toBeInstanceOf(InvalidStockQtyException);
  });
});
