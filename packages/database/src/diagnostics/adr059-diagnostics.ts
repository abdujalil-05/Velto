// ADR-059 read-only money/precision diagnostics, per company:
//   (a) SalesOrderLine whose stored lineTotal ≠ round(qty × unitPrice × (1 − d/100) × (1 + v/100), 2)
//   (b) InvoiceLine, same check (InvoiceLine has no discountPct; it is taken from the
//       order line it was copied from — see SalesService deliver — when that match is unique).
//       Only order-linked lines are checked: the sole production path that writes
//       InvoiceLine is delivery (always with orderId; OPENING invoices have no lines),
//       so order-less lines are reported apart as an origin anomaly (e.g. test fixtures).
//   (c) packaging qty consistency (qty = orderedPackQty × factor) — NOT checkable: the
//       ordered pack quantity is never stored, only the base-unit qty. Reported as skipped.
//   (d) products whose price-list price is below their minPrice
//   (e) companies whose defaultVatRate ≠ 12, and products whose vatRate ≠ company default
//
// Cross-tenant by definition, so it runs on `systemPrisma` (BYPASSRLS). Every
// statement is SELECT inside a READ ONLY transaction (any write fails with
// 25006) and is scoped by companyId. Output is counts and UUIDs only — no
// names, phones, SKUs or amounts. It never corrects anything and exits 0
// whatever it finds.
//
// Run:
//   pnpm --filter @velto/database exec tsx src/diagnostics/adr059-diagnostics.ts [--company <uuid>]
import { runReadOnly } from '../audit-deleted-customers';
import { Prisma, systemPrisma } from '../index';

export const SAMPLE_LIMIT = 20;
const STANDARD_VAT = new Prisma.Decimal(12);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Sample = { count: number; sampleIds: string[] };

export type CompanyDiagnostics = {
  companyId: string;
  salesOrderLineMismatch: Sample;
  invoiceLineMismatch: Sample;
  /** Invoice lines whose discount cannot be recovered (no / ambiguous source order line); not checked. */
  invoiceLineDiscountUnknown: Sample;
  /** Invoice lines on an invoice without an order — no production path creates these; not checked. */
  invoiceLineWithoutOrder: Sample;
  /** Product ids with at least one price-list price below minPrice. */
  productsBelowMinPrice: Sample;
  defaultVatRate: string;
  defaultVatIsStandard: boolean;
  /** Live products whose vatRate differs from the company default. */
  productsVatDiffersFromDefault: Sample;
};

export const PACKAGING_QTY_CHECK = {
  checked: false,
  reason: 'SalesOrderLine stores only base-unit qty; the ordered pack quantity is not persisted, so qty = packQty × factor cannot be verified.',
} as const;

type Row = { id: string; total: number };

function toSample(rows: Row[]): Sample {
  return { count: rows[0]?.total ?? 0, sampleIds: rows.map((r) => r.id) };
}

/** Fails closed: refuses to run on a transaction that could write. */
async function assertReadOnly(tx: Prisma.TransactionClient): Promise<void> {
  const [row] = await tx.$queryRaw<{ readOnly: string }[]>`SELECT current_setting('transaction_read_only') AS "readOnly"`;
  if (row?.readOnly !== 'on') throw new Error('adr059-diagnostics: transaction is not read-only');
}

export async function diagnoseCompany(tx: Prisma.TransactionClient, companyId: string): Promise<CompanyDiagnostics> {
  await assertReadOnly(tx);
  const company = Prisma.sql`${companyId}::uuid`;
  const limit = Prisma.sql`${SAMPLE_LIMIT}`;

  const solRows = await tx.$queryRaw<Row[]>`
    SELECT l.id::text AS id, (COUNT(*) OVER ())::int AS total
    FROM "SalesOrderLine" l
    JOIN "SalesOrder" o ON o.id = l."orderId"
    WHERE o."companyId" = ${company}
      AND round(l.qty * l."unitPrice" * (1 - l."discountPct" / 100) * (1 + l."vatRate" / 100), 2) <> l."lineTotal"
    ORDER BY l.id
    LIMIT ${limit}`;

  // discount: the discountPct of the order line(s) with the same
  // product/unitPrice/vatRate, if they all agree.
  const invoiceLines = Prisma.sql`
    SELECT il.id, il.qty, il."unitPrice", il."vatRate", il."lineTotal",
      CASE WHEN cardinality(src.discounts) = 1 THEN src.discounts[1] END AS discount
    FROM "InvoiceLine" il
    JOIN "Invoice" i ON i.id = il."invoiceId"
    LEFT JOIN LATERAL (
      SELECT array_agg(DISTINCT sol."discountPct") AS discounts
      FROM "SalesOrderLine" sol
      WHERE sol."orderId" = i."orderId" AND sol."productId" = il."productId"
        AND sol."unitPrice" = il."unitPrice" AND sol."vatRate" = il."vatRate"
    ) src ON true
    WHERE i."companyId" = ${company} AND i."orderId" IS NOT NULL`;

  const ilRows = await tx.$queryRaw<Row[]>`
    SELECT x.id::text AS id, (COUNT(*) OVER ())::int AS total
    FROM (${invoiceLines}) x
    WHERE x.discount IS NOT NULL
      AND round(x.qty * x."unitPrice" * (1 - x.discount / 100) * (1 + x."vatRate" / 100), 2) <> x."lineTotal"
    ORDER BY x.id
    LIMIT ${limit}`;

  const ilUnknownRows = await tx.$queryRaw<Row[]>`
    SELECT x.id::text AS id, (COUNT(*) OVER ())::int AS total
    FROM (${invoiceLines}) x
    WHERE x.discount IS NULL
    ORDER BY x.id
    LIMIT ${limit}`;

  const ilNoOrderRows = await tx.$queryRaw<Row[]>`
    SELECT il.id::text AS id, (COUNT(*) OVER ())::int AS total
    FROM "InvoiceLine" il
    JOIN "Invoice" i ON i.id = il."invoiceId"
    WHERE i."companyId" = ${company} AND i."orderId" IS NULL
    ORDER BY il.id
    LIMIT ${limit}`;

  const belowMinRows = await tx.$queryRaw<Row[]>`
    SELECT p.id::text AS id, (COUNT(*) OVER ())::int AS total
    FROM "Product" p
    WHERE p."companyId" = ${company} AND p."deletedAt" IS NULL AND p."minPrice" IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM "PriceListItem" pli
        JOIN "PriceList" pl ON pl.id = pli."priceListId" AND pl."companyId" = p."companyId"
        WHERE pli."productId" = p.id AND pli.price < p."minPrice"
      )
    ORDER BY p.id
    LIMIT ${limit}`;

  const [vat] = await tx.$queryRaw<{ defaultVatRate: Prisma.Decimal }[]>`
    SELECT "defaultVatRate" FROM "Company" WHERE id = ${company}`;
  if (!vat) throw new Error('adr059-diagnostics: company not found');

  const vatDiffRows = await tx.$queryRaw<Row[]>`
    SELECT p.id::text AS id, (COUNT(*) OVER ())::int AS total
    FROM "Product" p
    JOIN "Company" c ON c.id = p."companyId"
    WHERE p."companyId" = ${company} AND p."deletedAt" IS NULL AND p."vatRate" <> c."defaultVatRate"
    ORDER BY p.id
    LIMIT ${limit}`;

  const defaultVatRate = new Prisma.Decimal(vat.defaultVatRate);
  return {
    companyId,
    salesOrderLineMismatch: toSample(solRows),
    invoiceLineMismatch: toSample(ilRows),
    invoiceLineDiscountUnknown: toSample(ilUnknownRows),
    invoiceLineWithoutOrder: toSample(ilNoOrderRows),
    productsBelowMinPrice: toSample(belowMinRows),
    defaultVatRate: defaultVatRate.toFixed(2),
    defaultVatIsStandard: defaultVatRate.equals(STANDARD_VAT),
    productsVatDiffersFromDefault: toSample(vatDiffRows),
  };
}

function hasFindings(d: CompanyDiagnostics): boolean {
  return (
    d.salesOrderLineMismatch.count +
      d.invoiceLineMismatch.count +
      d.invoiceLineDiscountUnknown.count +
      d.invoiceLineWithoutOrder.count +
      d.productsBelowMinPrice.count +
      d.productsVatDiffersFromDefault.count >
      0 || !d.defaultVatIsStandard
  );
}

/**
 * Runs inside the caller's (read-only) transaction. With `companyId` only that
 * company is inspected and always reported; otherwise every company is scanned
 * and only those with a finding are listed.
 */
export async function diagnose(tx: Prisma.TransactionClient, companyId?: string) {
  await assertReadOnly(tx);
  const ids = companyId
    ? await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM "Company" WHERE id = ${companyId}::uuid`
    : await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM "Company" ORDER BY id`;
  const companies: CompanyDiagnostics[] = [];
  for (const { id } of ids) {
    const d = await diagnoseCompany(tx, id);
    if (companyId || hasFindings(d)) companies.push(d);
  }
  const sum = (pick: (d: CompanyDiagnostics) => number) => companies.reduce((n, d) => n + pick(d), 0);
  return {
    scope: companyId ? 'company' : 'all',
    companiesScanned: ids.length,
    sampleLimit: SAMPLE_LIMIT,
    packagingQtyCheck: PACKAGING_QTY_CHECK,
    totals: {
      salesOrderLineMismatch: sum((d) => d.salesOrderLineMismatch.count),
      invoiceLineMismatch: sum((d) => d.invoiceLineMismatch.count),
      invoiceLineDiscountUnknown: sum((d) => d.invoiceLineDiscountUnknown.count),
      invoiceLineWithoutOrder: sum((d) => d.invoiceLineWithoutOrder.count),
      productsBelowMinPrice: sum((d) => d.productsBelowMinPrice.count),
      companiesWithNonStandardDefaultVat: companies.filter((d) => !d.defaultVatIsStandard).length,
      productsVatDiffersFromDefault: sum((d) => d.productsVatDiffersFromDefault.count),
    },
    companies,
  };
}

export function parseArgs(argv: string[]): { companyId?: string } {
  const at = argv.indexOf('--company');
  if (at === -1) return {};
  const companyId = argv[at + 1];
  if (!companyId || !UUID_RE.test(companyId)) throw new Error('adr059-diagnostics: --company requires a UUID');
  return { companyId };
}

async function main(): Promise<void> {
  const { companyId } = parseArgs(process.argv.slice(2));
  const result = await runReadOnly((tx) => diagnose(tx, companyId));
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => systemPrisma.$disconnect());
}
