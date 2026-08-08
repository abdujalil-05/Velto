# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Velto — a sales & distribution management platform for Uzbekistan distributors (agents, warehouse,
sales, finance, 1C integration). The full functional/technical spec is [`VELTO-TZ.md`](./VELTO-TZ.md)
(Uzbek) — comments throughout the codebase cite it by section (e.g. `6.10`, `SEC-020..024`, `9.1`).
When a comment references a TZ section number and something is unclear, check that doc before guessing.

Turborepo + pnpm monorepo, started from scratch (no shared code/history with any other Velto project).

## Repo layout

```
apps/
  api/      NestJS 10 backend
  web/      Next.js 15 web app (owner/director/warehouse/cashier/accountant UI)
  miniapp/  Next.js 15 Telegram Mini App (sales agents), offline-first
packages/
  database/ Prisma schema, migrations, tenant-aware client, seed/bootstrap scripts
```

## Setup

```bash
pnpm install
cp .env.example .env
docker-compose up -d   # postgres:5432, redis:6379, minio:9000/9001

# One-time per database, must run as a Postgres superuser (not the app role).
# Creates the BYPASSRLS `velto_system` role used for phone-lookup login and
# cross-tenant background jobs.
psql "$DATABASE_URL" -f packages/database/scripts/provision-roles.sql

pnpm db:migrate    # prisma migrate dev
pnpm db:seed       # demo tenant "Demo Distribution" — refuses to run if NODE_ENV=production
pnpm dev           # turbo run dev, all apps
```

`apps/api` reads `API_PORT` (default 3001), `apps/web` reads `WEB_PORT` (default 3000), `apps/miniapp`
reads `MINIAPP_PORT` (default 3002). Env vars are validated at boot by `apps/api/src/common/config/env.schema.ts`
(zod) — it fails fast on a missing/malformed var rather than on first use.

To create a single Owner-only tenant instead of the full demo seed (e.g. for a clean login):
`pnpm --filter @velto/database exec tsx src/bootstrap-owner.ts [companyName] [ownerPhone] [firstName] [lastName]`
— prints the generated password once, to stdout only (never stored in plaintext).

## Commands

```bash
pnpm build        # turbo run build (all workspaces)
pnpm lint         # turbo run lint
pnpm typecheck    # turbo run typecheck
pnpm test         # turbo run test — requires a running Postgres + Redis (see below)

# Single test file, from the relevant workspace:
pnpm --filter @velto/api exec vitest run src/modules/sales/sales.service.test.ts
pnpm --filter @velto/database exec vitest run src/__tests__/tenant-isolation.test.ts
pnpm --filter @velto/miniapp exec vitest run src/lib/offline/queue.test.ts

# Single Prisma migration:
pnpm --filter @velto/database exec prisma migrate dev --name <description>
```

`apps/web` currently has no `test` script/suite. CI (`.github/workflows/ci.yml`) is the source of truth
for exact setup order: install → `prisma generate` → `migrate deploy` → provision-roles.sql → lint →
typecheck → test → `pnpm audit --prod` → build, plus a separate Semgrep SAST job. Reproduce that order
locally when a test needs a real DB — most API and database-package tests are **integration tests against
real Postgres with RLS enabled**, not mocked.

## Architecture

### Multi-tenancy is enforced at the database level, not just in application code

Every tenant-scoped table has Postgres RLS **and `FORCE ROW LEVEL SECURITY`** (migration
`20260730161500_rls_and_audit_lock`), so even the owning DB role is subject to it. All application code
must read/write through `withTenant(companyId, fn)` (`packages/database/src/client.ts`), which opens a
transaction and does `SET LOCAL app.current_company_id` — that's what makes RLS policies evaluate true
for that tenant's rows. A bare `prisma.customer.findMany()` outside of that returns **zero rows** (fails
closed, never leaks another tenant's data).

In `apps/api`, don't call `withTenant` directly — inject `TenantPrismaService` and read
`tenantPrisma.client` / `tenantPrisma.companyId` inside request handling; the transaction is already open
because `TenantContextInterceptor` (global, see `app.module.ts`) wraps every non-`@Public` request in one.
Deeper code that isn't handed `tx` explicitly can reach the same transaction via `TenantContext.current`
(`common/tenant/tenant-context.ts`, backed by `AsyncLocalStorage`) — this is intentional so `tx` doesn't
have to be threaded through every function signature.

There is a second Prisma client, `systemPrisma` (Postgres role `velto_system`, `BYPASSRLS`), reserved for
the narrow set of legitimately cross-tenant operations: resolving a user by phone during login
(`companyId` isn't part of the login request by design — TZ 15.2), platform-admin provisioning scripts,
and cross-tenant background jobs. Once such code knows the `companyId`, it should switch to `withTenant`
for the actual mutation.

Adding a new tenant-scoped table requires: a `companyId` column (or a subquery policy against its parent,
for line-item/join tables), an RLS policy in a new migration, and a case added to
`packages/database/src/__tests__/tenant-isolation.test.ts`. Non-negotiable per TZ 6.10 / SEC-001..005.

### Auth & RBAC request pipeline (`apps/api`)

Two-stage, both wired globally in `app.module.ts`:

1. `JwtAuthGuard` — verifies the access token signature/expiry only (cheap, no DB). Sets `request.tokenPayload`.
2. `TenantContextInterceptor` — opens the tenant transaction (`TenantPrismaService.run`), re-reads the
   user's current roles/permissions **from the DB every request** (never trusts the JWT payload for
   these — they can change inside a token's 15-minute lifetime), enforces `@RequirePermission('module.action')`,
   and sets `request.user` (`AuthenticatedUser`). A denied permission is audit-logged (SEC-054).

Routes opt out of both with `@Public()`. Controllers read the current permission requirement via
`@RequirePermission(...)` and the resolved user via `@CurrentUser()`.

RBAC is fixed system roles only in MVP (no custom-role authoring, `[v1.1]`). The role/permission catalog
is defined **twice** and must be kept in sync manually:
- `packages/database/src/seed.ts` (`SYSTEM_ROLES`, `ROLE_PERMISSIONS`, full demo seed)
- `packages/database/src/bootstrap-owner.ts` (same lists, for a fresh single-Owner tenant)

Display names for roles are also duplicated per-locale in `apps/web/messages/{uz,ru,en}.json` under
`AppShell.roles`, keyed by role `code`. A role rename/add/remove touches all of these plus, for
already-provisioned tenants, a one-off data-fix script (see `packages/database/src/rename-system-roles.ts`
for the pattern).

### Error contract

Domain errors are thrown as `AppException` (`apps/api/src/common/errors/app-exception.ts`), never a bare
`throw new Error()` — the global filter (`common/filters/http-exception.filter.ts`) relies on it to
produce the trilingual response contract: `{ code, message: { uz, ru, en }, details? }`. Each module has
its own `<module>-exceptions.ts` file exporting its `AppException` subclasses.

### NestJS module conventions (`apps/api/src/modules/*`)

One directory per domain module: `<name>.module.ts`, `<name>.controller.ts`, `<name>.service.ts`,
`<name>-exceptions.ts`, `dto/`, and a colocated `<name>.service.test.ts`. Sub-resources within a large
module get their own subdirectory (e.g. `catalog/{categories,products,price-lists}/`). Most tests
instantiate the service directly with `new` against the real `systemPrisma`/`withTenant`, rather than
going through Nest's DI container — the one exception is `apps/api/test/order-flow.e2e.test.ts`, which
uses `Test.createTestingModule` to exercise guards/interceptors/pipes end-to-end (this is why
`vitest.config.ts` needs the SWC plugin, for decorator metadata Nest's DI needs).

BullMQ queues run **in-process inside `apps/api`** (`common/queue/queue.module.ts`), not a separate
worker deployable — a deliberate single-developer-MVP simplification; producer/consumer code still lives
in the owning feature module (e.g. `modules/integrations/export-1c`), so splitting it out later is a
deploy-config change, not a rewrite. Side effects that must only fire after a transaction's writes are
durably visible (e.g. enqueueing a job) go through `TenantContext.afterCommit(cb)`, not a direct call
mid-transaction.

### Domain model (`packages/database/prisma/schema.prisma`)

Tenant (→ Company) → Users/Roles/Permissions, Customers/Outlets, Catalog (Product/Category/PriceList),
Warehouse/Stock, SalesOrder → Invoice → Payment/CashSession, Routes/RouteRuns/Visits (field agent
tracking), Suppliers/PurchaseOrders, plus cross-cutting AuditLog (append-only, DB-trigger-enforced —
even `velto_system` cannot UPDATE/DELETE it), OutboxEvent, ImportJob/ExportJob, Notification. Money is
`Decimal(18,2)`, quantities `Decimal(18,3)`, percentages `Decimal(5,2)` (schema header, section 6.1) —
never `Float`. StockMovement and Payment are append-only sources of truth, not mutated in place.

### Web app (`apps/web`)

Next.js App Router under `src/app/[locale]/`, i18n via `next-intl` (uz/ru/en, `src/i18n/`), auth screens
outside the `(app)` route group. API access is one file per resource under `src/lib/api/` — a thin
`useXQuery`/`useXMutation` wrapper (TanStack Query) around `apiFetch` (`src/lib/api/client.ts`), which
attaches the access token, retries once through `/auth/refresh` on a 401 (refresh token travels as an
httpOnly cookie, not JS-visible), and throws a typed `ApiError` carrying the trilingual message.

### Miniapp (`apps/miniapp`)

Telegram Mini App for sales agents, offline-first (TZ section 10): `src/lib/offline/` wraps Dexie
(IndexedDB) with per-row AES-GCM encryption (`encrypted-store.ts`/`crypto.ts`) and a local mutation queue
(`queue.ts`) that syncs against the API's `/sync/pull` and `/sync/push` (`apps/api/src/modules/sync/`).
The Dexie schema (`db.ts`) intentionally mirrors what `GET /sync/pull` sends — keep both in sync when
adding a synced entity. `storage-budget.ts` enforces the 50MB on-device storage cap (TZ 10.3).
