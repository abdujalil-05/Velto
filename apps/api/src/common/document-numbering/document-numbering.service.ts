import { Injectable } from '@nestjs/common';
import { Prisma, type TenantClient } from '@velto/database';

export type DocumentType = 'SO' | 'INV' | 'PAY' | 'PO';

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
    const year = new Date().getFullYear();
    const rows = await tx.$queryRaw<{ lastNumber: number }[]>(Prisma.sql`
      INSERT INTO "DocumentCounter" ("companyId", "docType", "year", "lastNumber", "updatedAt")
      VALUES (${companyId}::uuid, ${docType}, ${year}, 1, now())
      ON CONFLICT ("companyId", "docType", "year")
      DO UPDATE SET "lastNumber" = "DocumentCounter"."lastNumber" + 1, "updatedAt" = now()
      RETURNING "lastNumber"
    `);
    const lastNumber = rows[0]!.lastNumber;
    return `${docType}-${year}-${String(lastNumber).padStart(6, '0')}`;
  }
}
