import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, systemPrisma } from '@velto/database';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import {
  InsufficientStockException,
  InvalidStockQtyException,
  StockMovementAlreadyReversedException,
  StockMovementNotReversibleException,
  StockReversalInsufficientException,
} from './stock-exceptions';
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

  it('parallel first receipts for a fresh product/warehouse both succeed (ON CONFLICT DO NOTHING, no P2002)', async () => {
    const freshProductId = await tenantPrisma.run(companyId, async (tx) => {
      const p = await tx.product.create({
        data: { companyId, sku: `STOCK-RACE-${Date.now()}`, name: 'Race Product', baseUnit: 'dona', vatRate: 12 },
      });
      return p.id;
    });

    const results = await Promise.allSettled(
      [10, 20, 30, 40].map((qty) =>
        tenantPrisma.run(companyId, () => stock.receive({ productId: freshProductId, warehouseId, qty }, user)),
      ),
    );
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);

    const level = await tenantPrisma.run(companyId, (tx) =>
      tx.stockLevel.findUnique({ where: { productId_warehouseId: { productId: freshProductId, warehouseId } } }),
    );
    expect(level?.onHand.toString()).toBe('100');
    const movements = await tenantPrisma.run(companyId, (tx) =>
      tx.stockMovement.count({ where: { productId: freshProductId, warehouseId, type: 'RECEIVE' } }),
    );
    expect(movements).toBe(4);
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
  describe('reverseMovement() (F2.1)', () => {
    async function freshProduct() {
      return tenantPrisma.run(companyId, async (tx) =>
        (await tx.product.create({ data: { companyId, sku: `REV-${Date.now()}-${Math.random()}`, name: 'Rev', baseUnit: 'dona', vatRate: 12 } })).id,
      );
    }
    async function lastMovement(pid: string, type: 'RECEIVE' | 'ADJUST' | 'RESERVE') {
      return tenantPrisma.run(companyId, (tx) =>
        tx.stockMovement.findFirstOrThrow({ where: { productId: pid, warehouseId, type, reversesMovementId: null }, orderBy: { createdAt: 'desc' } }),
      );
    }
    /** onHand rebuilt from the append-only ledger must equal the StockLevel projection. */
    async function assertLedgerMatches(pid: string) {
      const [movements, level] = await tenantPrisma.run(companyId, (tx) =>
        Promise.all([
          tx.stockMovement.findMany({ where: { productId: pid, warehouseId } }),
          tx.stockLevel.findUniqueOrThrow({ where: { productId_warehouseId: { productId: pid, warehouseId } } }),
        ]),
      );
      const onHand = movements.reduce((sum, m) => {
        if (m.type === 'RECEIVE' || m.type === 'ADJUST') return sum + Number(m.qty);
        if (m.type === 'ISSUE') return sum - Number(m.qty);
        return sum;
      }, 0);
      expect(Number(level.onHand)).toBe(onHand);
      return level;
    }

    it('reverses a manual RECEIVE with a compensating row; original untouched; audit; second reverse rejected', async () => {
      const pid = await freshProduct();
      await tenantPrisma.run(companyId, () => stock.receive({ productId: pid, warehouseId, qty: 50 }, user));
      const original = await lastMovement(pid, 'RECEIVE');

      const { movement, level } = await tenantPrisma.run(companyId, () => stock.reverseMovement(original.id, ' wrong qty ', user));
      expect(movement.type).toBe('RECEIVE');
      expect(movement.qty.toString()).toBe('-50');
      expect(movement.reversesMovementId).toBe(original.id);
      expect(movement.reason).toBe('wrong qty');
      expect(level?.onHand.toString()).toBe('0');

      const reread = await tenantPrisma.run(companyId, (tx) => tx.stockMovement.findUniqueOrThrow({ where: { id: original.id } }));
      expect(reread).toEqual(original);
      await assertLedgerMatches(pid);

      const audit = await tenantPrisma.run(companyId, (tx) =>
        tx.auditLog.findFirstOrThrow({ where: { action: 'stock.reverse', entityId: movement.id } }),
      );
      expect(audit.userId).toBe(user.id);

      await expect(tenantPrisma.run(companyId, () => stock.reverseMovement(original.id, 'again', user))).rejects.toBeInstanceOf(
        StockMovementAlreadyReversedException,
      );
      await expect(tenantPrisma.run(companyId, () => stock.reverseMovement(movement.id, 'reverse the reversal', user))).rejects.toBeInstanceOf(
        StockMovementNotReversibleException,
      );
    });

    it('reverses a negative ADJUST (adds stock back)', async () => {
      const pid = await freshProduct();
      await tenantPrisma.run(companyId, () => stock.receive({ productId: pid, warehouseId, qty: 20 }, user));
      await tenantPrisma.run(companyId, () => stock.adjust({ productId: pid, warehouseId, qty: -5, reason: 'damage' }, user));
      const adj = await lastMovement(pid, 'ADJUST');
      const { level } = await tenantPrisma.run(companyId, () => stock.reverseMovement(adj.id, 'not damaged', user));
      expect(level?.onHand.toString()).toBe('20');
      await assertLedgerMatches(pid);
    });

    it('refuses RESERVE and document-linked RECEIVE movements', async () => {
      const pid = await freshProduct();
      await tenantPrisma.run(companyId, (tx) =>
        stock.receiveForRef(tx, { companyId, productId: pid, warehouseId, qty: 10, refType: 'GoodsReceipt', refId: randomUUID() }),
      );
      const gr = await lastMovement(pid, 'RECEIVE');
      await expect(tenantPrisma.run(companyId, () => stock.reverseMovement(gr.id, 'linked doc', user))).rejects.toBeInstanceOf(
        StockMovementNotReversibleException,
      );
      await tenantPrisma.run(companyId, (tx) =>
        stock.reserve(tx, { companyId, productId: pid, warehouseId, qty: 1, refType: 'SalesOrder', refId: randomUUID() }),
      );
      const res = await lastMovement(pid, 'RESERVE');
      await expect(tenantPrisma.run(companyId, () => stock.reverseMovement(res.id, 'reserve', user))).rejects.toBeInstanceOf(
        StockMovementNotReversibleException,
      );
    });

    it('refuses a reversal that would take on-hand below reserved; nothing is written', async () => {
      const pid = await freshProduct();
      await tenantPrisma.run(companyId, () => stock.receive({ productId: pid, warehouseId, qty: 10 }, user));
      const rec = await lastMovement(pid, 'RECEIVE');
      await tenantPrisma.run(companyId, (tx) =>
        stock.reserve(tx, { companyId, productId: pid, warehouseId, qty: 8, refType: 'SalesOrder', refId: randomUUID() }),
      );
      await expect(tenantPrisma.run(companyId, () => stock.reverseMovement(rec.id, 'over', user))).rejects.toBeInstanceOf(
        StockReversalInsufficientException,
      );
      const level = await assertLedgerMatches(pid);
      expect(level.onHand.toString()).toBe('10');
      expect(level.reserved.toString()).toBe('8');
    });

    it('race: parallel reversals of one movement — exactly one succeeds, stock = ledger', async () => {
      const pid = await freshProduct();
      await tenantPrisma.run(companyId, () => stock.receive({ productId: pid, warehouseId, qty: 30 }, user));
      await tenantPrisma.run(companyId, () => stock.receive({ productId: pid, warehouseId, qty: 7 }, user));
      const rec = await lastMovement(pid, 'RECEIVE');
      const results = await Promise.allSettled(
        [1, 2, 3, 4].map(() => tenantPrisma.run(companyId, () => stock.reverseMovement(rec.id, 'race reverse', user))),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results.filter((x) => x.status === 'rejected')) {
        expect((r as PromiseRejectedResult).reason).toBeInstanceOf(StockMovementAlreadyReversedException);
      }
      const level = await assertLedgerMatches(pid);
      expect(level.onHand.toString()).toBe(rec.qty.equals(30) ? '7' : '30');
    });
  });
});
