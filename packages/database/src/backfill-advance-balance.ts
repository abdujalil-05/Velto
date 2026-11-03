// One-off, idempotent data fix (F2.1 step 3, advance / avans): the customer
// balance formula now subtracts the advance — the unapplied part of POSTED
// payments — so an over-payment shows as credit (negative balance). Every
// Customer.cachedBalance written before that change ignored the advance and
// drifts from the ledger until the customer's next payment/invoice. This
// script recomputes cachedBalance for every customer of every company from
// the ledger with exactly CustomersService.getLedger()'s formula:
//
//   balance = Σ live invoices − Σ valid allocations to them − advance
//   advance = Σ POSTED payments − their allocations to live invoices
//   (live = Invoice.status <> 'CANCELLED'; valid = Payment.status = 'POSTED')
//
// Only the projection column is touched — no ledger row (Invoice, Payment,
// PaymentAllocation) is read for write or changed. Each changed customer is
// row-locked, updated and audit-logged (old/new) in one transaction; an
// unchanged customer is skipped, so re-running is a no-op.
//
// Cross-tenant by definition, so it runs on `systemPrisma` (BYPASSRLS) — the
// platform-admin case. Every query is still scoped by companyId/customerId.
//
// Run (try --dry-run first, it prints the drift without writing):
//   pnpm --filter @velto/database exec tsx src/backfill-advance-balance.ts --dry-run
//   pnpm --filter @velto/database exec tsx src/backfill-advance-balance.ts
//
// Against a production database (nothing is written without this):
//   NODE_ENV=production ALLOW_PRODUCTION_BACKFILL=1 pnpm --filter @velto/database exec tsx src/backfill-advance-balance.ts
import 'dotenv/config';
import { Prisma, systemPrisma } from './index';

const DRY_RUN = process.argv.includes('--dry-run');

if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PRODUCTION_BACKFILL !== '1') {
  console.error(
    'Refusing to run: NODE_ENV=production. Re-run with ALLOW_PRODUCTION_BACKFILL=1 once reviewed (try --dry-run first).',
  );
  process.exit(1);
}

type LedgerRow = { cachedBalance: Prisma.Decimal; balance: Prisma.Decimal; advance: Prisma.Decimal };

/** Same formula as CustomersService.getLedger(), in one statement, under FOR UPDATE on the customer row. */
function ledgerQuery(companyId: string, customerId: string, lock: boolean) {
  return Prisma.sql`
    WITH c AS (
      SELECT id, "cachedBalance" FROM "Customer"
      WHERE id = ${customerId}::uuid AND "companyId" = ${companyId}::uuid
      ${lock ? Prisma.sql`FOR UPDATE` : Prisma.empty}
    ),
    t AS (
      SELECT
        COALESCE((SELECT SUM(i.total) FROM "Invoice" i
          WHERE i."customerId" = ${customerId}::uuid AND i.status <> 'CANCELLED'), 0) AS invoiced,
        COALESCE((SELECT SUM(a.amount) FROM "PaymentAllocation" a
          JOIN "Invoice" i ON i.id = a."invoiceId" JOIN "Payment" p ON p.id = a."paymentId"
          WHERE i."customerId" = ${customerId}::uuid AND i.status <> 'CANCELLED' AND p.status = 'POSTED'), 0) AS allocated,
        COALESCE((SELECT SUM(p.amount) FROM "Payment" p
          WHERE p."customerId" = ${customerId}::uuid AND p.status = 'POSTED'), 0)
        - COALESCE((SELECT SUM(a.amount) FROM "PaymentAllocation" a
          JOIN "Invoice" i ON i.id = a."invoiceId" JOIN "Payment" p ON p.id = a."paymentId"
          WHERE p."customerId" = ${customerId}::uuid AND p.status = 'POSTED' AND i.status <> 'CANCELLED'), 0) AS advance
    )
    SELECT c."cachedBalance", (t.invoiced - t.allocated - t.advance) AS balance, t.advance
    FROM c CROSS JOIN t`;
}

async function backfillCompany(company: { id: string; name: string }): Promise<{ checked: number; fixed: number }> {
  const customers = await systemPrisma.customer.findMany({
    where: { companyId: company.id },
    select: { id: true, code: true },
    orderBy: { createdAt: 'asc' },
  });

  let fixed = 0;
  for (const customer of customers) {
    const changed = await systemPrisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<LedgerRow[]>(ledgerQuery(company.id, customer.id, !DRY_RUN));
      if (!row || new Prisma.Decimal(row.cachedBalance).equals(row.balance)) return false;

      console.log(
        `  [${company.name}] ${customer.code}: cachedBalance ${row.cachedBalance.toString()} -> ${row.balance.toString()} (advance ${row.advance.toString()})`,
      );
      if (DRY_RUN) return true;

      await tx.customer.update({ where: { id: customer.id }, data: { cachedBalance: row.balance } });
      await tx.auditLog.create({
        data: {
          companyId: company.id,
          userId: null,
          action: 'customer.cached_balance_backfill',
          entity: 'Customer',
          entityId: customer.id,
          oldValue: { cachedBalance: row.cachedBalance.toString() },
          newValue: { cachedBalance: row.balance.toString(), advance: row.advance.toString(), reason: 'F2.1 advance in balance' },
        },
      });
      return true;
    });
    if (changed) fixed++;
  }
  return { checked: customers.length, fixed };
}

async function main() {
  if (DRY_RUN) console.log('DRY RUN — no writes will be performed.\n');

  const companies = await systemPrisma.company.findMany({ select: { id: true, name: true }, orderBy: { createdAt: 'asc' } });

  let checked = 0;
  let fixed = 0;
  for (const company of companies) {
    const r = await backfillCompany(company);
    checked += r.checked;
    fixed += r.fixed;
  }

  console.log('\n--- Summary ---');
  console.log(`Companies processed:   ${companies.length}`);
  console.log(`Customers checked:     ${checked}`);
  console.log(`cachedBalance drifted: ${fixed}${DRY_RUN ? ' (dry run — nothing was written)' : ' (recomputed + audited)'}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => process.exit(0));
