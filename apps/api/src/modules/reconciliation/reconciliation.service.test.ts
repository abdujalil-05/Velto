import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, systemPrisma } from '@velto/database';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { DocumentNumberingService } from '../../common/document-numbering/document-numbering.service';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { CustomersService } from '../customers/customers.service';
import { PaymentsService } from '../finance/payments/payments.service';
import { StockService } from '../stock/stock.service';
import {
  ReconciliationBusyException,
  ReconciliationFindingAlreadyFixedException,
  ReconciliationSnapshotRequiredException,
} from './reconciliation-exceptions';
import { ReconciliationService } from './reconciliation.service';

describe('ReconciliationService (integration, real Postgres + RLS)', () => {
  const tenantPrisma = new TenantPrismaService();
  const auditLog = new AuditLogService();
  const customers = new CustomersService(tenantPrisma, auditLog);
  const payments = new PaymentsService(
    tenantPrisma,
    auditLog,
    customers,
    new DocumentNumberingService(),
  );
  const stock = new StockService(tenantPrisma, auditLog);
  const recon = new ReconciliationService(tenantPrisma, auditLog, customers);

  let companyId: string;
  let user: AuthenticatedUser;
  let warehouseId: string;
  let p1: string;
  let p2: string;
  let customerId: string;

  async function setupCompany(tag: string) {
    const tenant = await systemPrisma.tenant.create({
      data: { slug: `test-recon-${tag}-${Date.now()}`, name: `Recon ${tag}` },
    });
    const company = await systemPrisma.company.create({
      data: { tenantId: tenant.id, name: `Recon ${tag} Co` },
    });
    const dbUser = await systemPrisma.user.create({
      data: {
        companyId: company.id,
        firstName: 'Re',
        lastName: 'Con',
        phone: `+99890${Math.floor(1e6 + Math.random() * 8e6)}`,
      },
    });
    const u: AuthenticatedUser = {
      id: dbUser.id,
      companyId: company.id,
      firstName: 'Re',
      lastName: 'Con',
      roles: ['OWNER'],
      permissions: [],
    };
    const ids = await tenantPrisma.run(company.id, async (tx) => {
      const w = await tx.warehouse.create({ data: { companyId: company.id, name: 'W' } });
      const a = await tx.product.create({
        data: {
          companyId: company.id,
          sku: `R1-${tag}`,
          name: 'R1',
          baseUnit: 'dona',
          vatRate: 12,
        },
      });
      const b = await tx.product.create({
        data: {
          companyId: company.id,
          sku: `R2-${tag}`,
          name: 'R2',
          baseUnit: 'dona',
          vatRate: 12,
        },
      });
      return { w: w.id, a: a.id, b: b.id };
    });
    return { companyId: company.id, user: u, ...ids };
  }

  const detect = (cid = companyId, u = user) =>
    recon.runDetection(cid, { trigger: 'MANUAL', triggeredById: u.id });
  const openFindings = (cid = companyId) =>
    tenantPrisma.run(cid, (tx) =>
      tx.reconciliationFinding.findMany({ where: { status: 'OPEN' }, orderBy: { kind: 'asc' } }),
    );
  const level = (productId: string) =>
    tenantPrisma.run(companyId, (tx) =>
      tx.stockLevel.findUniqueOrThrow({
        where: { productId_warehouseId: { productId, warehouseId } },
      }),
    );
  const move = (productId: string, qty: number) => ({
    companyId,
    productId,
    warehouseId,
    qty,
    refType: 'SalesOrder',
    refId: randomUUID(),
  });

  beforeAll(async () => {
    const c = await setupCompany('a');
    ({ companyId, user } = c);
    warehouseId = c.w;
    p1 = c.a;
    p2 = c.b;

    // Stock: receipts, a reversed receipt, a negative ADJUST, partial delivery (reserve 10 → issue 6 + release 4).
    await tenantPrisma.run(companyId, () =>
      stock.receive({ productId: p1, warehouseId, qty: 100 }, user),
    );
    await tenantPrisma.run(companyId, () =>
      stock.receive({ productId: p1, warehouseId, qty: 20 }, user),
    );
    const toReverse = await tenantPrisma.run(companyId, (tx) =>
      tx.stockMovement.findFirstOrThrow({ where: { productId: p1, qty: 20 } }),
    );
    await tenantPrisma.run(companyId, () =>
      stock.reverseMovement(toReverse.id, 'entered twice', user),
    );
    await tenantPrisma.run(companyId, () =>
      stock.adjust({ productId: p1, warehouseId, qty: -5, reason: 'damaged' }, user),
    );
    await tenantPrisma.run(companyId, async (tx) => {
      const m = move(p1, 10);
      await stock.reserve(tx, m);
      await stock.issue(tx, { ...m, qty: 6 });
      await stock.release(tx, { ...m, qty: 4 });
    });
    await tenantPrisma.run(companyId, () =>
      stock.receive({ productId: p2, warehouseId, qty: 50 }, user),
    );

    // Balance: invoice 100000, payment 30000 (FIFO), payment 10000 then reversed.
    const { customer } = await tenantPrisma.run(companyId, () =>
      customers.create({ code: `RC-${Date.now()}`, name: 'Recon Customer' }, user),
    );
    customerId = (customer as { id: string }).id;
    await tenantPrisma.run(companyId, (tx) =>
      tx.invoice.create({
        data: {
          companyId,
          number: `RC-INV-${Date.now()}`,
          customerId,
          total: '100000',
          status: 'OPEN',
        },
      }),
    );
    await tenantPrisma.run(companyId, () =>
      payments.create({ customerId, amount: 30000, method: 'CASH' }, user),
    );
    const p = await tenantPrisma.run(companyId, () =>
      payments.create({ customerId, amount: 10000, method: 'CASH' }, user),
    );
    await tenantPrisma.run(companyId, () =>
      payments.reverse((p as { id: string }).id, 'wrong customer', user),
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  it('clean ledger (reversals, partial delivery, reversed payment) → no findings', async () => {
    const r = await detect();
    expect(r).toMatchObject({
      stockChecked: 2,
      stockFindings: 0,
      balanceChecked: 1,
      balanceFindings: 0,
      selfHealed: 0,
    });
    expect(await openFindings()).toEqual([]);
    const run = await tenantPrisma.run(companyId, (tx) =>
      tx.reconciliationRun.findUniqueOrThrow({ where: { id: r.runId } }),
    );
    expect(run.finishedAt).not.toBeNull();
    expect(run.triggeredById).toBe(user.id);
  });

  it('detect() refuses a READ COMMITTED transaction (needs one snapshot)', async () => {
    await expect(
      tenantPrisma.run(companyId, (tx) => recon.detect(tx, { trigger: 'SCHEDULED' })),
    ).rejects.toBeInstanceOf(ReconciliationSnapshotRequiredException);
  });

  describe('tampered projections', () => {
    let stockFindingId: string;
    let balanceFindingId: string;

    it('reports exact expected/actual/diff for StockLevel and cachedBalance', async () => {
      await systemPrisma.stockLevel.update({
        where: { productId_warehouseId: { productId: p1, warehouseId } },
        data: { onHand: '96', reserved: '3' },
      });
      await systemPrisma.customer.update({
        where: { id: customerId },
        data: { cachedBalance: '65000.50' },
      });

      const r = await detect();
      expect(r).toMatchObject({ stockFindings: 1, balanceFindings: 1, selfHealed: 0 });
      const [s, b] = await openFindings();
      expect(s).toMatchObject({
        kind: 'STOCK',
        productId: p1,
        warehouseId,
        runId: r.runId,
        lastRunId: r.runId,
      });
      expect([s.expectedOnHand, s.actualOnHand, s.diffOnHand].map(String)).toEqual([
        '89',
        '96',
        '7',
      ]);
      expect([s.expectedReserved, s.actualReserved, s.diffReserved].map(String)).toEqual([
        '0',
        '3',
        '3',
      ]);
      expect(b).toMatchObject({ kind: 'BALANCE', customerId });
      expect([b.expectedBalance, b.actualBalance, b.diffBalance].map(String)).toEqual([
        '70000',
        '65000.5',
        '-4999.5',
      ]);
      stockFindingId = s.id;
      balanceFindingId = b.id;
    });

    it('repeat run updates the OPEN finding (no duplicate), keeps first runId', async () => {
      await systemPrisma.stockLevel.update({
        where: { productId_warehouseId: { productId: p1, warehouseId } },
        data: { onHand: '97' },
      });
      const r = await detect();
      const open = await openFindings();
      expect(open).toHaveLength(2);
      const s = open.find((f) => f.kind === 'STOCK')!;
      expect(s.id).toBe(stockFindingId);
      expect(s.lastRunId).toBe(r.runId);
      expect(s.runId).not.toBe(r.runId);
      expect(String(s.diffOnHand)).toBe('8');
    });

    it('fix() rewrites projections from the ledger, sets FIXED, audits old/new, ledger untouched', async () => {
      const movementsBefore = await tenantPrisma.run(companyId, (tx) => tx.stockMovement.count());
      const fs = await tenantPrisma.run(companyId, () => recon.fix(stockFindingId, user));
      const fb = await tenantPrisma.run(companyId, () => recon.fix(balanceFindingId, user));
      expect(fs.outcome).toBe('FIXED');
      expect(fb.outcome).toBe('FIXED');
      expect(fs.finding).toMatchObject({ status: 'FIXED', fixedById: user.id });
      expect(fs.finding.fixedAt).not.toBeNull();

      const l = await level(p1);
      expect([String(l.onHand), String(l.reserved)]).toEqual(['89', '0']);
      const c = await tenantPrisma.run(companyId, (tx) =>
        tx.customer.findUniqueOrThrow({ where: { id: customerId } }),
      );
      expect(String(c.cachedBalance)).toBe('70000');
      expect(await tenantPrisma.run(companyId, (tx) => tx.stockMovement.count())).toBe(
        movementsBefore,
      );

      const audit = await tenantPrisma.run(companyId, (tx) =>
        tx.auditLog.findFirstOrThrow({
          where: { action: 'reconciliation.fix', entityId: stockFindingId },
        }),
      );
      expect(audit.oldValue).toMatchObject({ kind: 'STOCK', onHand: '97', reserved: '3' });
      expect(audit.newValue).toMatchObject({
        kind: 'STOCK',
        outcome: 'FIXED',
        onHand: '89',
        reserved: '0',
      });
      const auditB = await tenantPrisma.run(companyId, (tx) =>
        tx.auditLog.findFirstOrThrow({
          where: { action: 'reconciliation.fix', entityId: balanceFindingId },
        }),
      );
      expect(auditB.oldValue).toMatchObject({ cachedBalance: '65000.5' });
      expect(auditB.newValue).toMatchObject({ cachedBalance: '70000' });

      await expect(
        tenantPrisma.run(companyId, () => recon.fix(stockFindingId, user)),
      ).rejects.toBeInstanceOf(ReconciliationFindingAlreadyFixedException);
      const r = await detect();
      expect(r).toMatchObject({ stockFindings: 0, balanceFindings: 0 });
      expect(await openFindings()).toEqual([]);
    });
  });

  it('self-healed drift: finding stays OPEN with old lastRunId; fix() closes it without writing', async () => {
    await systemPrisma.stockLevel.update({
      where: { productId_warehouseId: { productId: p2, warehouseId } },
      data: { onHand: '51' },
    });
    const first = await detect();
    await systemPrisma.stockLevel.update({
      where: { productId_warehouseId: { productId: p2, warehouseId } },
      data: { onHand: '50' },
    });
    const second = await detect();
    expect(second).toMatchObject({ stockFindings: 0, selfHealed: 1 });
    const [f] = await openFindings();
    expect(f.lastRunId).toBe(first.runId);

    const before = await level(p2);
    const res = await tenantPrisma.run(companyId, () => recon.fix(f.id, user));
    expect(res.outcome).toBe('ALREADY_CONSISTENT');
    expect(res.finding.status).toBe('FIXED');
    const after = await level(p2);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    const audit = await tenantPrisma.run(companyId, (tx) =>
      tx.auditLog.findFirstOrThrow({ where: { action: 'reconciliation.fix', entityId: f.id } }),
    );
    expect(audit.newValue).toMatchObject({ outcome: 'ALREADY_CONSISTENT', onHand: '50' });
  });

  it('other tenant: its drift and findings are invisible', async () => {
    const other = await setupCompany('b');
    await tenantPrisma.run(other.companyId, () =>
      stock.receive({ productId: other.a, warehouseId: other.w, qty: 5 }, other.user),
    );
    await systemPrisma.stockLevel.update({
      where: { productId_warehouseId: { productId: other.a, warehouseId: other.w } },
      data: { onHand: '9' },
    });
    const mine = await detect();
    expect(mine).toMatchObject({ stockChecked: 2, stockFindings: 0, balanceFindings: 0 });

    const theirs = await detect(other.companyId, other.user);
    expect(theirs).toMatchObject({ stockChecked: 1, stockFindings: 1, balanceChecked: 0 });
    expect(await openFindings()).toEqual([]);
    expect(await openFindings(other.companyId)).toHaveLength(1);
  });

  it('race: detection during concurrent deliveries/payments reports no false findings', async () => {
    await tenantPrisma.run(companyId, () =>
      stock.receive({ productId: p2, warehouseId, qty: 1000 }, user),
    );
    let writing = true;
    const writers = Array.from({ length: 4 }, async (_, i) => {
      let n = 0;
      while (writing && n < 40) {
        n++;
        if (i % 2 === 0) {
          await tenantPrisma.run(companyId, async (tx) => {
            const m = move(p2, 3);
            await stock.reserve(tx, m);
            await stock.issue(tx, { ...m, qty: 2 });
            await stock.release(tx, { ...m, qty: 1 });
          });
        } else {
          await tenantPrisma.run(companyId, () =>
            payments.create({ customerId, amount: 1, method: 'CASH' }, user),
          );
        }
      }
    });
    const runs = [];
    for (let k = 0; k < 4; k++) runs.push(await detect());
    writing = false;
    await Promise.all(writers);
    for (const r of runs) expect(r).toMatchObject({ stockFindings: 0, balanceFindings: 0 });
    expect(await openFindings()).toEqual([]);
  });

  it('race: fix() vs concurrent reservations — StockLevel ends equal to the ledger', async () => {
    await systemPrisma.stockLevel.update({
      where: { productId_warehouseId: { productId: p2, warehouseId } },
      data: { onHand: { increment: 5 } },
    });
    await detect();
    const [f] = await openFindings();
    const results = await Promise.allSettled([
      tenantPrisma.run(companyId, () => recon.fix(f.id, user)),
      ...Array.from({ length: 5 }, () =>
        tenantPrisma.run(companyId, (tx) => stock.reserve(tx, move(p2, 1))),
      ),
    ]);
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    const r = await detect();
    expect(r.stockFindings).toBe(0);
  });

  it('race: parallel detections — one wins or both serialize, never duplicate OPEN findings', async () => {
    await systemPrisma.customer.update({
      where: { id: customerId },
      data: { cachedBalance: { increment: 1 } },
    });
    const results = await Promise.allSettled([detect(), detect(), detect()]);
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(ReconciliationBusyException);
    }
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    const open = await openFindings();
    expect(open).toHaveLength(1);
    expect(String(open[0].diffBalance)).toBe('1');
  });
});
