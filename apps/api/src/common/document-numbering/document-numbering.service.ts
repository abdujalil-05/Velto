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
