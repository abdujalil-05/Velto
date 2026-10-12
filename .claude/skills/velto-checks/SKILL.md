---
name: velto-checks
description: CI-order verification commands and failure-compression rules; preloaded by the checks subagent.
---

CI order (`.github/workflows/ci.yml` is the source of truth): install → `prisma generate` → `migrate deploy` → provision-roles.sql → lint → typecheck → test → `pnpm audit --prod` → build (+ separate Semgrep job).

Commands: `pnpm lint` · `pnpm typecheck` · `pnpm test` (needs Postgres+Redis: `docker-compose up -d`) · `pnpm build`.
Scoped: `pnpm --filter @velto/<api|web|miniapp|database> exec tsc --noEmit` · `pnpm --filter @velto/api exec vitest run <file>`.

Rules:
- `apps/web` has no test suite — typecheck only.
- Most API/database tests are integration tests on real Postgres with RLS: DB/Redis down (ECONNREFUSED, P1001) ⇒ SKIPPED, not FAIL.
- Pipe output through `tail -n 40` / `grep -E 'error|FAIL|✗'`; one line per distinct failure; never paste stack traces.
- Release blockers per spec: tenant-isolation failure, any P0 test skipped, critical/high audit finding — name these explicitly if seen.
