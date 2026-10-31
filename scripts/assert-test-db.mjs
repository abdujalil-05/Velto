// Fail-fast guard: tests may only touch explicitly approved throwaway databases.
// Used as vitest setup file (apps/api, packages/database) and as CLI by root `pnpm test`.
// NODE_ENV=test alone is NOT proof. Allowed DB names: velto_test, velto_ci; velto_load (pnpm test:perf) and
// velto_ci_local (scripts/ci-local.sh sets it) only with VELTO_TEST_DB_ALLOW=<that db>. Hosts: localhost, 127.0.0.1,
// ::1, postgres (CI service) unless VELTO_TEST_DB_ALLOW names the db. Always denied: velto_dev, names containing prod/pilot/staging, port 5433
// (dev stack) unless VELTO_TEST_DB_ALLOW names exactly that (approved) DB and it is not velto_dev/prod/pilot.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const KEYS = [
  'DATABASE_URL', 'DATABASE_MIGRATE_URL', 'DATABASE_SYSTEM_URL', 'DATABASE_ADMIN_URL',
  'DATABASE_LOAD_URL', 'DATABASE_LOAD_SYSTEM_URL',
];
const ALWAYS_OK = ['velto_test', 'velto_ci'];
const OPT_IN_OK = ['velto_load', 'velto_ci_local'];
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]', 'postgres'];

function parseEnvFile(f) {
  const out = {};
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && KEYS.includes(m[1])) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

function nearestEnv(start) {
  let d = start;
  for (let i = 0; i < 8; i += 1) {
    const f = join(d, '.env');
    if (existsSync(f)) return f;
    const p = dirname(d);
    if (p === d) break;
    d = p;
  }
  return null;
}

// Every .env the app/config may load (nearest from script dir and cwd, root, apps/api, packages/database): all are checked.
function fileEnvs() {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, '..');
  const files = new Set([nearestEnv(here), nearestEnv(process.cwd()), join(root, '.env'), join(root, 'apps/api/.env'), join(root, 'packages/database/.env')]);
  return [...files].filter((f) => f && existsSync(f)).map((f) => ({ f, vars: parseEnvFile(f) }));
}

export function checkTestDatabases(env = process.env) {
  const allow = (env.VELTO_TEST_DB_ALLOW ?? '').trim();
  const problems = [];
  const targets = [];
  const real = Object.fromEntries(KEYS.filter((k) => env[k]).map((k) => [k, env[k]]));
  for (const k of Object.keys(real)) targets.push([k, real[k], 'env']);
  for (const { f, vars } of fileEnvs()) for (const k of Object.keys(vars)) if (!real[k]) targets.push([k, vars[k], f]);
  if (!real.DATABASE_URL && !targets.some(([k]) => k === 'DATABASE_URL')) problems.push('DATABASE_URL is not set');
  for (const [k, raw, src] of targets) {
    const label = src === 'env' ? k : `${k} (${src})`;
    let u;
    try { u = new URL(raw); } catch { problems.push(`${label}: unparsable URL`); continue; }
    const db = decodeURIComponent(u.pathname.replace(/^\//, ''));
    const port = u.port || '5432';
    const bad = /prod|pilot|staging/i.test(db + u.hostname) || db === 'velto_dev' || db === 'postgres';
    const approved = ALWAYS_OK.includes(db) || (OPT_IN_OK.includes(db) && allow === db);
    if (bad || !approved) problems.push(`${label}: database "${db}" on ${u.hostname}:${port} is not an approved test DB`);
    else if (!LOCAL_HOSTS.includes(u.hostname) && allow !== db) problems.push(`${label}: host "${u.hostname}" is not local (localhost/127.0.0.1/::1/postgres)`);
    else if (port === '5433' && allow !== db) problems.push(`${label}: port 5433 is the dev stack (set VELTO_TEST_DB_ALLOW=${db} only if that DB is a throwaway)`);
  }
  return problems;
}

export function assertTestDatabases(env = process.env) {
  const problems = checkTestDatabases(env);
  if (problems.length === 0) return;
  throw new Error(
    `REFUSING TO RUN TESTS: unsafe database target (tests write fixtures and truncate).\n  - ${problems.join('\n  - ')}\n` +
      'Run the isolated stack instead: scripts/test-isolated.sh [-- --filter=@velto/database]\n' +
      '(allowed test DBs: velto_test, velto_ci; pnpm test:perf on velto_load needs VELTO_TEST_DB_ALLOW=velto_load; velto_ci_local needs VELTO_TEST_DB_ALLOW=velto_ci_local, set by scripts/ci-local.sh).',
  );
}

assertTestDatabases();
