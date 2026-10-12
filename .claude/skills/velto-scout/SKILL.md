---
name: velto-scout
description: Velto repo map and TZ v4.0 section index; preloaded by the scout subagent.
---

# Repo map
- `apps/api/src/modules/<domain>/` → `<name>.{module,controller,service}.ts`, `<name>-exceptions.ts`, `dto/`, `<name>.service.test.ts`
- `apps/api/src/common/` → `tenant/`, `errors/`, `filters/`, `queue/`, `config/env.schema.ts`; e2e: `apps/api/test/`
- `packages/database/` → `prisma/schema.prisma`, `prisma/migrations/`, `src/{client,seed,bootstrap-owner}.ts`, `src/__tests__/tenant-isolation.test.ts`, `scripts/provision-roles.sql`
- `apps/web/src/{app/[locale],lib/api,i18n}`, `apps/web/messages/{uz,ru,en}.json`
- `apps/miniapp/src/lib/offline/` → `db.ts`, `queue.ts`, `crypto.ts`, `encrypted-store.ts`, `storage-budget.ts`
- `deploy/`, `.github/workflows/ci.yml`, `docker-compose.yml`, `CLAUDE.md`

# Spec: `docs/VELTO-TZ-v4.0.md` (Uzbek, 86 KB — find sections with grep, never read whole)
Outline: `grep -n '^#' docs/VELTO-TZ-v4.0.md`. Sections: 3.3 KPIs · 4 roles/RBAC · 5.1 modules M00–M13 · 5.2 NOT in MVP · 6.1 data rules · 6.3 statuses+numbering · 6.4 stock · 6.5 finance · 6.6 money/VAT · 7.1 API standards · 7.3 1C · 7.4 Telegram · 7.5 events · 8 offline/sync (8.3 rules, 8.4 conflicts, 8.5 tests) · 9.2 web screens · 9.3 mini-app screens · 9.4 GPS · 10.4 RLS · 10.5 concurrency · 11 security · 12 NFR · 15.2/15.3 DoR/DoD · 16 acceptance (P0/P1) · 17 tests/CI · 18 risks · 19 ADR log.

# Legacy numbering (older TZ cited in code comments and CLAUDE.md; file in git at `e56389d:VELTO-TZ.md`)
6.10 / SEC-001..005 → §10.4 · 10 (offline), 10.3 → §8, §8.3 · 15 / SEC-0xx (security) → §11 (15.2 auth→11.1, 15.3 authz→11.2, 15.4 data→11.3, 15.6 audit→11.4) · 9.x UI → §9 · 8.x business rules → §6.3–6.6 · 11.x 1C/delivery → §7.3, §15, §10.3.
