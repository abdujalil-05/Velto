import { Injectable } from '@nestjs/common';
import { Prisma, type TenantClient } from '@velto/database';

export type DocumentType = 'SO' | 'INV' | 'PAY' | 'PO' | 'OB';

/**
 * 8.6: "SO-{yil}-{6 raqam}" etc., sequential and gapless-per-company,
 * numbers are never reused even for cancelled documents. A plain
 * `SELECT max(...) + 1` races under concurrent order creation (two
 * requests could read the same max and both insert the same number), so
 * this atomically increments a counter row via `INSERT ... ON CONFLICT DO
 * UPDATE ... RETURNING`, which Postgres serializes per row.
 *
 * GLOBAL WRITER LOCK ORDER (F7, 40P01 fix; TZ §6.3 forbids reuse, does not
 * promise gapless, line 930 wants numbering inside the business tx — so the
 * counter stays in-tx, rolled back with it, and is taken LAST):
 *   1. advisory xact locks (Idempotency-Key, export1c, route)
 *   2. header row FOR UPDATE: SalesOrder | Payment | CashSession | PO | OpeningBatch
 *   3. Customer(s), id asc — FOR UPDATE (ledger writers, sync push batch) or
 *      FOR KEY SHARE (order create). Never after step 4.
 *   4. StockLevel (productId, warehouseId) asc — deliver/confirm/reserve
 *   5. DocumentCounter, several types only in docType asc (INV < OB < PAY < PO < SO)
 *   6. INSERTs (FK KEY SHARE on rows already locked in 3 or never FOR UPDATE'd)
 * SO (F7 late counter, SalesService.createWithOutcome): Customer KEY SHARE ->
 * SalesOrder+lines INSERT under a 'TMP-<uuid>' placeholder (its FK KEY SHAREs
 * on Outlet/Warehouse/User/Product/Packaging now PRECEDE the counter) ->
 * courier order's StockLevel reservation (step 4) -> SO counter -> one UPDATE
 * of the own uncommitted SalesOrder.number (no FK column change => no new
 * KEY SHARE) -> audit INSERT (KEY SHARE User/Company, as before). No writer
 * takes FOR UPDATE on Product/Warehouse/Outlet/User/Company while holding a
 * counter, so the earlier KEY SHAREs cannot close a cycle.
 * One documented exception, acyclic: after PAY, Invoice FOR UPDATE of a
 * customer whose lock is held (step 3 guards them).
 * Regression: sync/lock-order-deadlock.test.ts.
 */
@Injectable()
export class DocumentNumberingService {
  async next(tx: TenantClient, companyId: string, docType: DocumentType): Promise<string> {
    return (await this.nextBlock(tx, companyId, docType, 1))[0]!;
  }

  /**
   * Reserves `count` consecutive numbers with ONE counter-row increment (same
   * row lock as next(), so concurrent next()/nextBlock() calls never overlap).
   * Rolled back with the caller's transaction, so no gap is left on failure.
   */
  async nextBlock(tx: TenantClient, companyId: string, docType: DocumentType, count: number): Promise<string[]> {
    if (!Number.isInteger(count) || count < 1) return [];
    const year = new Date().getFullYear();
    const rows = await tx.$queryRaw<{ lastNumber: number }[]>(Prisma.sql`
      INSERT INTO "DocumentCounter" ("companyId", "docType", "year", "lastNumber", "updatedAt")
      VALUES (${companyId}::uuid, ${docType}, ${year}, ${count}, now())
      ON CONFLICT ("companyId", "docType", "year")
      DO UPDATE SET "lastNumber" = "DocumentCounter"."lastNumber" + ${count}, "updatedAt" = now()
      RETURNING "lastNumber"
    `);
    const first = rows[0]!.lastNumber - count + 1;
    return Array.from({ length: count }, (_, i) => `${docType}-${year}-${String(first + i).padStart(6, '0')}`);
  }
}
