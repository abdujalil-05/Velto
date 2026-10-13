import { Injectable } from '@nestjs/common';
import {
  Prisma,
  ReconciliationKind,
  ReconciliationTrigger,
  type ReconciliationFinding,
  type TenantClient,
  type TenantTxOptions,
} from '@velto/database';
import { AuditLogService, toAuditJson } from '../../common/audit/audit-log.service';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { CustomersService } from '../customers/customers.service';
import {
  ReconciliationBusyException,
  ReconciliationFindingAlreadyFixedException,
  ReconciliationFindingNotFoundException,
  ReconciliationLedgerInvalidException,
  ReconciliationSnapshotRequiredException,
} from './reconciliation-exceptions';

/**
 * F2.5 / §6.4–6.5: detect() must read the ledger and the projections from ONE
 * snapshot, otherwise a delivery/payment committing mid-run looks like drift.
 * REPEATABLE READ gives that snapshot without taking any row lock, so
 * deliveries/payments are never blocked. Long timeout: it scans the tenant.
 */
export const RECONCILIATION_TX_OPTIONS: TenantTxOptions = {
  isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  maxWait: 10_000,
  timeout: 120_000,
};

export interface DetectOptions {
  trigger: ReconciliationTrigger;
  /** Required for MANUAL (DB CHECK), null for SCHEDULED. */
  triggeredById?: string | null;
}

export interface DetectResult {
  runId: string;
  stockChecked: number;
  stockFindings: number;
  balanceChecked: number;
  balanceFindings: number;
  /** OPEN findings whose drift is gone in this run — left OPEN and untouched (lastRunId stays old); fix() closes them without a write. */
  selfHealed: number;
}

export type FixOutcome = 'FIXED' | 'ALREADY_CONSISTENT';

export interface FixResult {
  finding: ReconciliationFinding;
  outcome: FixOutcome;
}

interface StockDriftRow {
  checked: number;
  productId: string | null;
  warehouseId: string | null;
  expectedOnHand: Prisma.Decimal | null;
  actualOnHand: Prisma.Decimal | null;
  expectedReserved: Prisma.Decimal | null;
  actualReserved: Prisma.Decimal | null;
}

const ZERO = new Prisma.Decimal(0);

/**
 * Ledger-derived stock per (product, warehouse), mirroring StockService:
 * onHand = ΣRECEIVE + ΣADJUST − ΣISSUE; reserved = ΣRESERVE − ΣRELEASE − ΣISSUE.
 * qty is summed signed: reversal rows (same type, negated qty) compensate.
 */
function movementAggSql(where: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    SELECT "productId", "warehouseId",
      COALESCE(SUM(CASE WHEN "type" IN ('RECEIVE', 'ADJUST') THEN "qty" WHEN "type" = 'ISSUE' THEN -"qty" ELSE 0 END), 0) AS "onHand",
      COALESCE(SUM(CASE WHEN "type" = 'RESERVE' THEN "qty" WHEN "type" IN ('RELEASE', 'ISSUE') THEN -"qty" ELSE 0 END), 0) AS "reserved"
    FROM "StockMovement" ${where}
    GROUP BY "productId", "warehouseId"`;
}

const stockKey = (productId: string, warehouseId: string) => `S:${productId}:${warehouseId}`;
const balanceKey = (customerId: string) => `B:${customerId}`;

@Injectable()
export class ReconciliationService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly auditLog: AuditLogService,
    private readonly customers: CustomersService,
  ) {}

  /**
   * Opens its own REPEATABLE READ tenant transaction (separate from any
   * request tx) and runs detect(). The snapshot is taken by withTenant's
   * first statement, just before the advisory try-lock; if another run/fix
   * commits in that gap our finding writes hit the OPEN unique index (P2002)
   * or a RR write conflict (P2034) — the whole run rolls back and is
   * reported as Busy (retry), never as a duplicate finding.
   */
  async runDetection(companyId: string, opts: DetectOptions): Promise<DetectResult> {
    try {
      return await this.tenantPrisma.run(
        companyId,
        (tx) => this.detect(tx, opts),
        RECONCILIATION_TX_OPTIONS,
      );
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        (e.code === 'P2002' || e.code === 'P2034')
      ) {
        throw new ReconciliationBusyException();
      }
      throw e;
    }
  }

  /**
   * Read-only w.r.t. ledger and projections: no FOR UPDATE, tolerance 0.
   * `tx` must be a tenant tx at REPEATABLE READ/SERIALIZABLE (see
   * RECONCILIATION_TX_OPTIONS) so every read below shares one snapshot.
   * One OPEN finding per subject: a repeat run updates it (lastRunId, values).
   */
  async detect(tx: TenantClient, opts: DetectOptions): Promise<DetectResult> {
    const [ctx] = await tx.$queryRaw<
      { isolation: string; companyId: string; locked: boolean }[]
    >(Prisma.sql`
      SELECT current_setting('transaction_isolation') AS isolation,
             current_setting('app.current_company_id') AS "companyId",
             pg_try_advisory_xact_lock(hashtext('velto.reconciliation'), hashtext(current_setting('app.current_company_id'))) AS locked
    `);
    if (ctx.isolation !== 'repeatable read' && ctx.isolation !== 'serializable') {
      throw new ReconciliationSnapshotRequiredException(ctx.isolation);
    }
    if (!ctx.locked) throw new ReconciliationBusyException();
    const companyId = ctx.companyId;

    const run = await tx.reconciliationRun.create({
      data: { companyId, trigger: opts.trigger, triggeredById: opts.triggeredById ?? null },
    });

    const open = await tx.reconciliationFinding.findMany({ where: { status: 'OPEN' } });
    const openByKey = new Map<string, ReconciliationFinding>();
    for (const f of open) {
      openByKey.set(
        f.kind === ReconciliationKind.STOCK
          ? stockKey(f.productId!, f.warehouseId!)
          : balanceKey(f.customerId!),
        f,
      );
    }
    const seen = new Set<string>();

    // STOCK — one statement: movement aggregate FULL JOIN StockLevel, drift rows only + checked count.
    const stockRows = await tx.$queryRaw<StockDriftRow[]>(Prisma.sql`
      WITH m AS (${movementAggSql(Prisma.empty)}),
      j AS (
        SELECT COALESCE(m."productId", l."productId") AS "productId",
               COALESCE(m."warehouseId", l."warehouseId") AS "warehouseId",
               COALESCE(m."onHand", 0) AS "expectedOnHand", COALESCE(l."onHand", 0) AS "actualOnHand",
               COALESCE(m."reserved", 0) AS "expectedReserved", COALESCE(l."reserved", 0) AS "actualReserved"
        FROM m FULL OUTER JOIN "StockLevel" l
          ON l."productId" = m."productId" AND l."warehouseId" = m."warehouseId"
      )
      SELECT c.checked, d."productId", d."warehouseId", d."expectedOnHand", d."actualOnHand", d."expectedReserved", d."actualReserved"
      FROM (SELECT COUNT(*)::int AS checked FROM j) c
      LEFT JOIN j d ON d."expectedOnHand" <> d."actualOnHand" OR d."expectedReserved" <> d."actualReserved"
      ORDER BY d."productId", d."warehouseId"
    `);
    const stockChecked = stockRows[0]?.checked ?? 0;
    let stockFindings = 0;
    for (const r of stockRows) {
      if (!r.productId || !r.warehouseId) continue;
      const values = {
        expectedOnHand: r.expectedOnHand!,
        actualOnHand: r.actualOnHand!,
        diffOnHand: r.actualOnHand!.minus(r.expectedOnHand!),
        expectedReserved: r.expectedReserved!,
        actualReserved: r.actualReserved!,
        diffReserved: r.actualReserved!.minus(r.expectedReserved!),
      };
      const key = stockKey(r.productId, r.warehouseId);
      seen.add(key);
      stockFindings++;
      await this.upsertFinding(
        tx,
        openByKey.get(key),
        run.id,
        { companyId, kind: ReconciliationKind.STOCK },
        {
          productId: r.productId,
          warehouseId: r.warehouseId,
          ...values,
        },
      );
    }

    // BALANCE — ledger via CustomersService.getLedger (single source of the formula), same snapshot.
    const customers = await tx.customer.findMany({
      select: { id: true, cachedBalance: true },
      orderBy: { id: 'asc' },
    });
    let balanceFindings = 0;
    for (const c of customers) {
      const { balance: expected } = await this.customers.getLedger(tx, c.id);
      if (expected.equals(c.cachedBalance)) continue;
      const key = balanceKey(c.id);
      seen.add(key);
      balanceFindings++;
      await this.upsertFinding(
        tx,
        openByKey.get(key),
        run.id,
        { companyId, kind: ReconciliationKind.BALANCE },
        {
          customerId: c.id,
          expectedBalance: expected,
          actualBalance: c.cachedBalance,
          diffBalance: c.cachedBalance.minus(expected),
        },
      );
    }

    const selfHealed = [...openByKey.keys()].filter((k) => !seen.has(k)).length;

    await tx.reconciliationRun.update({
      where: { id: run.id },
      data: {
        finishedAt: new Date(),
        stockChecked,
        stockFindings,
        balanceChecked: customers.length,
        balanceFindings,
      },
    });

    return {
      runId: run.id,
      stockChecked,
      stockFindings,
      balanceChecked: customers.length,
      balanceFindings,
      selfHealed,
    };
  }

  /**
   * Rewrites the projection (StockLevel or Customer.cachedBalance) from the
   * ledger and marks the finding FIXED. Never touches ledger rows. Locks:
   * advisory(shared, vs detect) → finding → StockLevel | Customer — nothing
   * in the delivery/payment paths locks a finding, so no cycle. Drift is
   * re-verified under the projection lock; if it is gone the finding is
   * closed with no projection write (outcome ALREADY_CONSISTENT).
   */
  async fix(findingId: string, user: AuthenticatedUser): Promise<FixResult> {
    const tx = this.tenantPrisma.client;
    await tx.$queryRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock_shared(hashtext('velto.reconciliation'), hashtext(current_setting('app.current_company_id')))::text
    `);
    const locked = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT id FROM "ReconciliationFinding" WHERE id = ${findingId}::uuid FOR UPDATE
    `);
    if (locked.length === 0) throw new ReconciliationFindingNotFoundException();
    const finding = await tx.reconciliationFinding.findUniqueOrThrow({ where: { id: findingId } });
    if (finding.status !== 'OPEN') throw new ReconciliationFindingAlreadyFixedException();

    const { oldValue, newValue, changed } =
      finding.kind === ReconciliationKind.STOCK
        ? await this.fixStock(tx, finding.productId!, finding.warehouseId!)
        : await this.fixBalance(tx, finding.customerId!);

    const updated = await tx.reconciliationFinding.update({
      where: { id: finding.id },
      data: { status: 'FIXED', fixedAt: new Date(), fixedById: user.id },
    });
    const outcome: FixOutcome = changed ? 'FIXED' : 'ALREADY_CONSISTENT';

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'reconciliation.fix',
      entity: 'ReconciliationFinding',
      entityId: finding.id,
      oldValue: toAuditJson({ kind: finding.kind, ...oldValue }),
      newValue: toAuditJson({ kind: finding.kind, outcome, ...newValue }),
    });

    return { finding: updated, outcome };
  }

  private async fixStock(tx: TenantClient, productId: string, warehouseId: string) {
    // Same row-creation pattern as StockService (movements may exist without a StockLevel row).
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "StockLevel" ("productId", "warehouseId", "onHand", "reserved", "updatedAt")
      VALUES (${productId}::uuid, ${warehouseId}::uuid, 0, 0, CURRENT_TIMESTAMP)
      ON CONFLICT ("productId", "warehouseId") DO NOTHING
    `);
    const [level] = await tx.$queryRaw<
      { onHand: Prisma.Decimal; reserved: Prisma.Decimal }[]
    >(Prisma.sql`
      SELECT "onHand", "reserved" FROM "StockLevel"
      WHERE "productId" = ${productId}::uuid AND "warehouseId" = ${warehouseId}::uuid
      FOR UPDATE
    `);
    // Every movement writer holds this row lock until commit, so the aggregate below is stable.
    const [agg] = await tx.$queryRaw<{ onHand: Prisma.Decimal; reserved: Prisma.Decimal }[]>(
      movementAggSql(
        Prisma.sql`WHERE "productId" = ${productId}::uuid AND "warehouseId" = ${warehouseId}::uuid`,
      ),
    );
    const expectedOnHand = agg?.onHand ?? ZERO;
    const expectedReserved = agg?.reserved ?? ZERO;

    const subject = { productId, warehouseId };
    const oldValue = { ...subject, onHand: level.onHand, reserved: level.reserved };
    if (level.onHand.equals(expectedOnHand) && level.reserved.equals(expectedReserved)) {
      return { oldValue, newValue: oldValue, changed: false };
    }
    if (
      expectedOnHand.isNegative() ||
      expectedReserved.isNegative() ||
      expectedReserved.greaterThan(expectedOnHand)
    ) {
      throw new ReconciliationLedgerInvalidException(
        expectedOnHand.toString(),
        expectedReserved.toString(),
      );
    }
    await tx.stockLevel.update({
      where: { productId_warehouseId: { productId, warehouseId } },
      data: { onHand: expectedOnHand, reserved: expectedReserved },
    });
    return {
      oldValue,
      newValue: { ...subject, onHand: expectedOnHand, reserved: expectedReserved },
      changed: true,
    };
  }

  private async fixBalance(tx: TenantClient, customerId: string) {
    // Customer lock = the lock every ledger writer holds (CustomersService.lockForUpdate).
    await this.customers.lockForUpdate(tx, customerId);
    const customer = await tx.customer.findUniqueOrThrow({
      where: { id: customerId },
      select: { cachedBalance: true },
    });
    const { balance: expected } = await this.customers.getLedger(tx, customerId);

    const oldValue = { customerId, cachedBalance: customer.cachedBalance };
    if (customer.cachedBalance.equals(expected))
      return { oldValue, newValue: oldValue, changed: false };
    await tx.customer.update({ where: { id: customerId }, data: { cachedBalance: expected } });
    return { oldValue, newValue: { customerId, cachedBalance: expected }, changed: true };
  }

  private async upsertFinding(
    tx: TenantClient,
    existing: ReconciliationFinding | undefined,
    runId: string,
    subject: Pick<Prisma.ReconciliationFindingUncheckedCreateInput, 'companyId' | 'kind'>,
    values: Omit<
      Prisma.ReconciliationFindingUncheckedCreateInput,
      'runId' | 'lastRunId' | 'companyId' | 'kind'
    >,
  ): Promise<void> {
    if (existing) {
      await tx.reconciliationFinding.update({
        where: { id: existing.id },
        data: { ...values, lastRunId: runId },
      });
    } else {
      await tx.reconciliationFinding.create({
        data: { ...subject, ...values, runId, lastRunId: runId },
      });
    }
  }
}
