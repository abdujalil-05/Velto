// ADR-061 read-only audit of soft-deleted customers, per company: ledger
// activity after deletion, unfinished orders, leftover reservations, money
// still owed either way, and `code` restore collisions.
//
// Cross-tenant by definition, so it runs on `systemPrisma` (BYPASSRLS) — the
// platform-admin case. Every statement is SELECT, runs in a READ ONLY
// transaction and is scoped by companyId. Output is counts and UUIDs only: no
// names, phones, customer codes or amounts. Being unable to write, it has no
// production guard, because pilot data is what this audit exists to inspect.
//
// Each order / code-conflict finding carries an ADR-061c resolution option
// code for the PO; the audit only suggests it, it never applies anything.
// `--summary` prints aggregated counts only: companies are anonymised to
// ordinal labels and no UUIDs at all are emitted.
//
// Run:
//   pnpm --filter @velto/database exec tsx src/audit-deleted-customers.ts [--summary]
import { OrderStatus, Prisma, systemPrisma } from './index';

const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = [OrderStatus.CLOSED, OrderStatus.CANCELLED];

/** Derived from the enum, so a future status is audited rather than silently skipped. */
export const NON_TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = Object.values(OrderStatus).filter(
  (status) => !TERMINAL_ORDER_STATUSES.includes(status),
);

export type CustomerRef = { customerId: string; id: string };

/**
 * ADR-061c resolution option per finding:
 * - CANCEL: SalesService.cancel() — releases the reservation (CONFIRMED) or has none (DRAFT/SUBMITTED).
 * - DELIVER_THEN_CLOSE: goods already left the warehouse (SHIPPED) or arrived (DELIVERED);
 *   cancelling would release stock that is physically gone, so finish delivery and close.
 * - RESTORE_REQUIRED: restoring the customer is blocked by a live customer's `code`;
 *   the PO renames one of them by hand first.
 */
export type ResolutionCode = 'CANCEL' | 'DELIVER_THEN_CLOSE' | 'RESTORE_REQUIRED';

/** Typed over every status, so a new OrderStatus fails to compile until it is mapped. Terminal → null. */
const ORDER_RESOLUTION: Record<OrderStatus, ResolutionCode | null> = {
  DRAFT: 'CANCEL',
  SUBMITTED: 'CANCEL',
  CONFIRMED: 'CANCEL',
  SHIPPED: 'DELIVER_THEN_CLOSE',
  DELIVERED: 'DELIVER_THEN_CLOSE',
  CLOSED: null,
  CANCELLED: null,
};

export type Finding = CustomerRef & { kind: 'ORDER' | 'CODE_CONFLICT'; resolution: ResolutionCode };

export type CompanyAudit = {
  companyId: string;
  deletedCustomers: number;
  allocationsAfterDelete: CustomerRef[];
  reversalsAfterDelete: CustomerRef[];
  /** One list per non-terminal status; `id` is the order id. */
  ordersByStatus: Record<string, CustomerRef[]>;
  /** Orders of any status with a non-zero ΣRESERVE − ΣRELEASE − ΣISSUE on some product. */
  remainingReservations: CustomerRef[];
  /** Customer ids. Same ledger formula as CustomersService.getLedger(). */
  nonZeroBalance: string[];
  nonZeroAdvance: string[];
  nonZeroCachedBalance: string[];
  pendingHandoverPayments: CustomerRef[];
  /** `id` is the live customer holding the code, which blocks restoring `customerId`. */
  codeReusedByActive: CustomerRef[];
};

/** Switches the current transaction to read-only. Postgres allows this at any point in a transaction. */
export async function enterReadOnly(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SET TRANSACTION READ ONLY`;
}

/** One consistent snapshot in which any write fails with 25006. */
export function runReadOnly<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return systemPrisma.$transaction(
    async (tx) => {
      await enterReadOnly(tx);
      return fn(tx);
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 10_000, timeout: 120_000 },
  );
}

/** Fails closed: the audit refuses to run on a transaction that could write. */
async function assertReadOnly(tx: Prisma.TransactionClient): Promise<void> {
  const [row] = await tx.$queryRaw<{ readOnly: string }[]>`SELECT current_setting('transaction_read_only') AS "readOnly"`;
  if (row?.readOnly !== 'on') throw new Error('audit-deleted-customers: transaction is not read-only');
}

export async function auditCompany(tx: Prisma.TransactionClient, companyId: string): Promise<CompanyAudit> {
  await assertReadOnly(tx);
  const company = Prisma.sql`${companyId}::uuid`;

  const [countRow] = await tx.$queryRaw<{ deletedCustomers: number }[]>`
    SELECT COUNT(*)::int AS "deletedCustomers" FROM "Customer"
    WHERE "companyId" = ${company} AND "deletedAt" IS NOT NULL`;

  // PaymentAllocation has no companyId; an allocation counts for the customer
  // on either side of it (the payment's or the invoice's).
  const allocationsAfterDelete = await tx.$queryRaw<CustomerRef[]>`
    SELECT c.id::text AS "customerId", a.id::text AS id
    FROM "Customer" c
    JOIN "Payment" p ON p."companyId" = c."companyId"
    JOIN "PaymentAllocation" a ON a."paymentId" = p.id
    JOIN "Invoice" i ON i.id = a."invoiceId" AND i."companyId" = c."companyId"
    WHERE c."companyId" = ${company} AND c."deletedAt" IS NOT NULL
      AND (p."customerId" = c.id OR i."customerId" = c.id)
      AND a."createdAt" > c."deletedAt"
    ORDER BY 1, 2`;

  const reversalsAfterDelete = await tx.$queryRaw<CustomerRef[]>`
    SELECT c.id::text AS "customerId", r.id::text AS id
    FROM "Customer" c
    JOIN "Payment" p ON p."customerId" = c.id AND p."companyId" = c."companyId"
    JOIN "PaymentReversal" r ON r."reversesPaymentId" = p.id AND r."companyId" = c."companyId"
    WHERE c."companyId" = ${company} AND c."deletedAt" IS NOT NULL
      AND r."createdAt" > c."deletedAt"
    ORDER BY 1, 2`;

  const orders = await tx.$queryRaw<(CustomerRef & { status: string })[]>`
    SELECT c.id::text AS "customerId", o.id::text AS id, o.status::text AS status
    FROM "Customer" c
    JOIN "SalesOrder" o ON o."customerId" = c.id AND o."companyId" = c."companyId"
    WHERE c."companyId" = ${company} AND c."deletedAt" IS NOT NULL
      AND o.status::text IN (${Prisma.join(NON_TERMINAL_ORDER_STATUSES.map(String))})
    ORDER BY 1, 2`;
  const ordersByStatus: Record<string, CustomerRef[]> = Object.fromEntries(
    NON_TERMINAL_ORDER_STATUSES.map((status) => [status, orders.filter((o) => o.status === status).map(({ customerId, id }) => ({ customerId, id }))]),
  );

  // Grouped per product first, so a surplus on one product can't hide a
  // shortfall on another. Reversal rows carry signed qty, so summing stays right.
  const remainingReservations = await tx.$queryRaw<CustomerRef[]>`
    SELECT DISTINCT t."customerId", t.id FROM (
      SELECT c.id::text AS "customerId", o.id::text AS id
      FROM "Customer" c
      JOIN "SalesOrder" o ON o."customerId" = c.id AND o."companyId" = c."companyId"
      JOIN "StockMovement" m ON m."refType" = 'SalesOrder' AND m."refId" = o.id AND m."companyId" = c."companyId"
      WHERE c."companyId" = ${company} AND c."deletedAt" IS NOT NULL
        AND m.type IN ('RESERVE', 'RELEASE', 'ISSUE')
      GROUP BY c.id, o.id, m."productId", m."warehouseId"
      HAVING SUM(CASE WHEN m.type = 'RESERVE' THEN m.qty ELSE -m.qty END) <> 0
    ) t
    ORDER BY 1, 2`;

  const ledger = await tx.$queryRaw<{ customerId: string; balanceNonZero: boolean; advanceNonZero: boolean; cachedNonZero: boolean }[]>`
    SELECT c.id::text AS "customerId",
      (t.invoiced - t.allocated - t.advance) <> 0 AS "balanceNonZero",
      t.advance <> 0 AS "advanceNonZero",
      c."cachedBalance" <> 0 AS "cachedNonZero"
    FROM "Customer" c
    CROSS JOIN LATERAL (
      SELECT
        COALESCE((SELECT SUM(i.total) FROM "Invoice" i
          WHERE i."customerId" = c.id AND i.status <> 'CANCELLED'), 0) AS invoiced,
        COALESCE((SELECT SUM(a.amount) FROM "PaymentAllocation" a
          JOIN "Invoice" i ON i.id = a."invoiceId" JOIN "Payment" p ON p.id = a."paymentId"
          WHERE i."customerId" = c.id AND i.status <> 'CANCELLED' AND p.status = 'POSTED'), 0) AS allocated,
        COALESCE((SELECT SUM(p.amount) FROM "Payment" p
          WHERE p."customerId" = c.id AND p.status = 'POSTED'), 0)
        - COALESCE((SELECT SUM(a.amount) FROM "PaymentAllocation" a
          JOIN "Invoice" i ON i.id = a."invoiceId" JOIN "Payment" p ON p.id = a."paymentId"
          WHERE p."customerId" = c.id AND p.status = 'POSTED' AND i.status <> 'CANCELLED'), 0) AS advance
    ) t
    WHERE c."companyId" = ${company} AND c."deletedAt" IS NOT NULL
    ORDER BY 1`;

  const pendingHandoverPayments = await tx.$queryRaw<CustomerRef[]>`
    SELECT c.id::text AS "customerId", p.id::text AS id
    FROM "Customer" c
    JOIN "Payment" p ON p."customerId" = c.id AND p."companyId" = c."companyId"
    WHERE c."companyId" = ${company} AND c."deletedAt" IS NOT NULL
      AND p.status = 'PENDING_HANDOVER'
    ORDER BY 1, 2`;

  // "Live" means deletedAt IS NULL, not isActive: this mirrors the partial
  // unique index Customer_companyId_code_live_key, which is what restore hits.
  const codeReusedByActive = await tx.$queryRaw<CustomerRef[]>`
    SELECT d.id::text AS "customerId", live.id::text AS id
    FROM "Customer" d
    JOIN "Customer" live ON live."companyId" = d."companyId" AND live.code = d.code AND live."deletedAt" IS NULL
    WHERE d."companyId" = ${company} AND d."deletedAt" IS NOT NULL
    ORDER BY 1, 2`;

  return {
    companyId,
    deletedCustomers: countRow?.deletedCustomers ?? 0,
    allocationsAfterDelete,
    reversalsAfterDelete,
    ordersByStatus,
    remainingReservations,
    nonZeroBalance: ledger.filter((row) => row.balanceNonZero).map((row) => row.customerId),
    nonZeroAdvance: ledger.filter((row) => row.advanceNonZero).map((row) => row.customerId),
    nonZeroCachedBalance: ledger.filter((row) => row.cachedNonZero).map((row) => row.customerId),
    pendingHandoverPayments,
    codeReusedByActive,
  };
}

/** Companies are audited one read-only transaction each, to keep every snapshot short. */
export async function auditDeletedCustomers(): Promise<{ companiesScanned: number; companies: CompanyAudit[] }> {
  const companyIds = await runReadOnly((tx) =>
    tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM "Company" ORDER BY id`,
  );
  const companies: CompanyAudit[] = [];
  for (const { id } of companyIds) {
    const audit = await runReadOnly((tx) => auditCompany(tx, id));
    if (audit.deletedCustomers > 0) companies.push(audit);
  }
  return { companiesScanned: companyIds.length, companies };
}

export function resolveFindings(audit: CompanyAudit): Finding[] {
  const orders = Object.entries(audit.ordersByStatus).flatMap(([status, refs]) => {
    const resolution = ORDER_RESOLUTION[status as OrderStatus];
    return resolution ? refs.map((ref): Finding => ({ ...ref, kind: 'ORDER', resolution })) : [];
  });
  const conflicts = audit.codeReusedByActive.map((ref): Finding => ({ ...ref, kind: 'CODE_CONFLICT', resolution: 'RESTORE_REQUIRED' }));
  return [...orders, ...conflicts];
}

type Tally = Record<string, number>;

function tally(keys: string[]): Tally {
  const out: Tally = {};
  for (const key of keys) out[key] = (out[key] ?? 0) + 1;
  return out;
}

function countsOf(audit: CompanyAudit) {
  return {
    deletedCustomers: audit.deletedCustomers,
    allocationsAfterDelete: audit.allocationsAfterDelete.length,
    reversalsAfterDelete: audit.reversalsAfterDelete.length,
    ordersByStatus: Object.fromEntries(Object.entries(audit.ordersByStatus).map(([status, refs]) => [status, refs.length])) as Tally,
    remainingReservations: audit.remainingReservations.length,
    nonZeroBalance: audit.nonZeroBalance.length,
    nonZeroAdvance: audit.nonZeroAdvance.length,
    nonZeroCachedBalance: audit.nonZeroCachedBalance.length,
    pendingHandoverPayments: audit.pendingHandoverPayments.length,
    codeReusedByActive: audit.codeReusedByActive.length,
    resolutions: tally(resolveFindings(audit).map((finding) => finding.resolution)),
  };
}

export type AuditCounts = ReturnType<typeof countsOf>;

function addCounts(a: AuditCounts, b: AuditCounts): AuditCounts {
  const out: Record<string, number | Tally> = { ...a };
  for (const [key, value] of Object.entries(b)) {
    if (typeof value === 'number') {
      out[key] = (out[key] as number) + value;
    } else {
      const merged: Tally = { ...(out[key] as Tally) };
      for (const [k, n] of Object.entries(value)) merged[k] = (merged[k] ?? 0) + n;
      out[key] = merged;
    }
  }
  return out as AuditCounts;
}

/** Full report: counts, UUID details and per-finding resolution codes. */
function summarize(audit: CompanyAudit) {
  return { companyId: audit.companyId, counts: countsOf(audit), resolutions: resolveFindings(audit), details: audit };
}

/** `--summary`: counts only, companies anonymised to ordinal labels — no UUIDs, names, phones or codes. */
export function anonymisedSummary({ companiesScanned, companies }: { companiesScanned: number; companies: CompanyAudit[] }) {
  const perCompany = companies.map((audit, index) => ({ company: `company-${index + 1}`, counts: countsOf(audit) }));
  const [first, ...rest] = perCompany.map((entry) => entry.counts);
  return {
    companiesScanned,
    companiesWithDeletedCustomers: companies.length,
    total: first ? rest.reduce(addCounts, first) : null,
    companies: perCompany,
  };
}

async function main(): Promise<void> {
  const result = await auditDeletedCustomers();
  const output = process.argv.includes('--summary')
    ? anonymisedSummary(result)
    : { companiesScanned: result.companiesScanned, companies: result.companies.map(summarize) };
  console.log(JSON.stringify(output, null, 2));
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => systemPrisma.$disconnect());
}
