import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config as loadDotenv } from 'dotenv';

/**
 * Side-effect import that guarantees `.env` is loaded *before* the module-level
 * `new PrismaClient(...)` calls in `client.ts` run.
 *
 * Why this is needed: `systemPrisma` passes `process.env.DATABASE_SYSTEM_URL`
 * explicitly, so the value is read at import time, not at connect time. Nothing
 * else has loaded the env by then — `apps/api` loads it via
 * `ConfigModule.forRoot({ envFilePath: ['../../.env', '.env'] })`, but the
 * `@Module` decorator only evaluates *after* every import of `app.module.ts`
 * has been resolved, and `@velto/database` is one of those imports. Previously
 * the generated Prisma Client happened to load the root `.env` as a side effect
 * of its own import; that stopped when the client was regenerated with a cwd
 * (`packages/database`) that contains no `.env`, baking `relativeEnvPaths: null`
 * into the generated bundle — and the API then crashed at boot with
 * "Invalid value undefined for datasource \"db\"".
 *
 * Loading it here rather than relying on that side effect keeps the package
 * correct no matter which directory `prisma generate` was run from.
 *
 * `override` stays false: a real environment (CI, production, docker) that
 * already exported these vars must always win over a stray checked-out `.env`.
 */
function loadNearestEnvFile(): void {
  const candidates: string[] = [];

  // Walk up from this file (packages/database/src → … → monorepo root) and from
  // the process cwd, whichever yields a `.env` first. Both are covered because
  // scripts in this package run from packages/database while apps/api runs from
  // its own directory.
  for (const start of [__dirname, process.cwd()]) {
    let dir = start;
    for (let depth = 0; depth < 8; depth += 1) {
      candidates.push(join(dir, '.env'));
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      loadDotenv({ path: candidate, override: false });
      return;
    }
  }
}

loadNearestEnvFile();
