// One-off data fix: any tenant provisioned via bootstrap-owner.ts before the
// SALES_AGENT display-name rename ("Savdo agenti" → "Agent") still carries
// the old name on its Role rows — this script updates them in place. Safe to
// run repeatedly (only touches rows still holding the old name) and safe on
// a database that already has no such rows (no-op).
import 'dotenv/config';
import { systemPrisma } from './index';

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to run: NODE_ENV=production. Review before running against real data.');
  process.exit(1);
}

const RENAMES: { code: string; from: string; to: string }[] = [{ code: 'SALES_AGENT', from: 'Savdo agenti', to: 'Agent' }];

async function main() {
  for (const rename of RENAMES) {
    const result = await systemPrisma.role.updateMany({
      where: { code: rename.code, name: rename.from },
      data: { name: rename.to },
    });
    console.log(`${rename.code}: "${rename.from}" -> "${rename.to}" (${result.count} row(s) updated)`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => process.exit(0));
