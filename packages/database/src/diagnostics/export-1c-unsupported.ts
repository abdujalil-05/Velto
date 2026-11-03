// ADR-059 read-only diagnostic: previously GENERATED / ACCOUNTING_ACCEPTED / FAILED_REVIEW 1C export jobs
// (XML/CSV only — EXCEL carries no lines) whose period contains SALE invoices that the strict-reject
// representability check (apps/api export-1c-representability.ts, mappingVersion 2) would now refuse.
// Reasons: DISCOUNT (SalesOrderLine.discountPct <> 0), VAT (InvoiceLine.vatRate <> 0),
// QTY_X_PRICE_MISMATCH (round(qty × unitPrice, 2) <> lineTotal), UNIT (ordered packaging qtyInBaseUnit <> 1),
// TOTAL_MISMATCH (Σ lineTotal <> Invoice.total). Postgres round() on numeric = HALF_UP for positive values.
//
// Invoices are evaluated in their CURRENT state (documents are immutable after delivery) over each job's period
// with the same filter as the exporter (kind SALE, not CANCELLED, createdAt within [periodFrom, periodTo]).
// Cross-tenant => systemPrisma, every statement is a SELECT inside a READ ONLY transaction, scoped by companyId.
// Output: job id/status/period + invoice id/number + reasons. Never writes, re-sends or changes anything; exits 0.
// Meaning: each listed job's file may contain documents whose amounts the accountant must re-check.
//
// Run:
//   pnpm --filter @velto/database exec tsx src/diagnostics/export-1c-unsupported.ts [--company <uuid>]
import { runReadOnly } from '../audit-deleted-customers';
import { Prisma, systemPrisma } from '../index';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const INVOICE_SAMPLE_LIMIT = 200;

export type Finding = { invoiceId: string; invoiceNumber: string; reasons: string[] };
export type JobFinding = { companyId: string; exportJobId: string; status: string; format: string; periodFrom: string; periodTo: string; offendingInvoices: number; invoices: Finding[] };

type Row = { companyId: string; jobId: string; status: string; format: string; periodFrom: Date; periodTo: Date; invoiceId: string; invoiceNumber: string; reasons: string[] };

async function assertReadOnly(tx: Prisma.TransactionClient): Promise<void> {
  const [row] = await tx.$queryRaw<{ readOnly: string }[]>`SELECT current_setting('transaction_read_only') AS "readOnly"`;
  if (row?.readOnly !== 'on') throw new Error('export-1c-unsupported: transaction is not read-only');
}

export async function diagnose(tx: Prisma.TransactionClient, companyId?: string) {
  await assertReadOnly(tx);
  const scope = companyId ? Prisma.sql`AND j."companyId" = ${companyId}::uuid` : Prisma.empty;
  const rows = await tx.$queryRaw<Row[]>`
    SELECT j."companyId"::text AS "companyId", j.id::text AS "jobId", j.status::text AS status, j.format::text AS format,
           j."periodFrom" AS "periodFrom", j."periodTo" AS "periodTo", i.id::text AS "invoiceId", i.number AS "invoiceNumber",
           ARRAY(SELECT r FROM unnest(ARRAY[
             CASE WHEN EXISTS (SELECT 1 FROM "InvoiceLine" il JOIN "SalesOrderLine" sol ON sol."orderId" = i."orderId" AND sol."productId" = il."productId"
                   AND sol."unitPrice" = il."unitPrice" AND sol."vatRate" = il."vatRate"
                   WHERE il."invoiceId" = i.id AND sol."discountPct" <> 0) THEN 'DISCOUNT' END,
             CASE WHEN EXISTS (SELECT 1 FROM "InvoiceLine" il WHERE il."invoiceId" = i.id AND il."vatRate" <> 0) THEN 'VAT' END,
             CASE WHEN EXISTS (SELECT 1 FROM "InvoiceLine" il WHERE il."invoiceId" = i.id AND round(il.qty * il."unitPrice", 2) <> il."lineTotal") THEN 'QTY_X_PRICE_MISMATCH' END,
             CASE WHEN EXISTS (SELECT 1 FROM "InvoiceLine" il JOIN "SalesOrderLine" sol ON sol."orderId" = i."orderId" AND sol."productId" = il."productId"
                   AND sol."unitPrice" = il."unitPrice" AND sol."vatRate" = il."vatRate"
                   JOIN "ProductPackaging" pp ON pp.id = sol."packagingId"
                   WHERE il."invoiceId" = i.id AND pp."qtyInBaseUnit" <> 1) THEN 'UNIT' END,
             CASE WHEN COALESCE((SELECT sum(il."lineTotal") FROM "InvoiceLine" il WHERE il."invoiceId" = i.id), 0) <> i.total THEN 'TOTAL_MISMATCH' END
           ]) AS r WHERE r IS NOT NULL) AS reasons
    FROM "ExportJob" j
    JOIN "Invoice" i ON i."companyId" = j."companyId" AND i.kind = 'SALE' AND i.status <> 'CANCELLED'
                    AND i."createdAt" >= j."periodFrom" AND i."createdAt" <= j."periodTo"
    WHERE j.type = '1c' AND j.format <> 'EXCEL' AND j.status IN ('GENERATED', 'ACCOUNTING_ACCEPTED', 'FAILED_REVIEW') ${scope}
    ORDER BY j."companyId", j."createdAt", j.id, i."createdAt", i.id`;

  const byJob = new Map<string, JobFinding>();
  for (const r of rows) {
    if (r.reasons.length === 0) continue;
    let job = byJob.get(r.jobId);
    if (!job) {
      job = { companyId: r.companyId, exportJobId: r.jobId, status: r.status, format: r.format, periodFrom: r.periodFrom.toISOString(), periodTo: r.periodTo.toISOString(), offendingInvoices: 0, invoices: [] };
      byJob.set(r.jobId, job);
    }
    job.offendingInvoices += 1;
    if (job.invoices.length < INVOICE_SAMPLE_LIMIT) job.invoices.push({ invoiceId: r.invoiceId, invoiceNumber: r.invoiceNumber, reasons: r.reasons });
  }
  const jobs = [...byJob.values()];
  return { scope: companyId ? 'company' : 'all', invoiceSampleLimit: INVOICE_SAMPLE_LIMIT, jobsNeedingAccountantRecheck: jobs.length, jobs };
}

export function parseArgs(argv: string[]): { companyId?: string } {
  const at = argv.indexOf('--company');
  if (at === -1) return {};
  const companyId = argv[at + 1];
  if (!companyId || !UUID_RE.test(companyId)) throw new Error('export-1c-unsupported: --company requires a UUID');
  return { companyId };
}

async function main(): Promise<void> {
  const { companyId } = parseArgs(process.argv.slice(2));
  console.log(JSON.stringify(await runReadOnly((tx) => diagnose(tx, companyId)), null, 2));
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => systemPrisma.$disconnect());
}
