---
name: velto-architect
description: Velto scope gate, module boundaries, ADR defaults and agent routing; preloaded by the architect subagent.
---

# Scope gate (§5.3) — a feature enters MVP only if you can answer
1) which validated customer problem 2) which KPI improves 3) how it's accepted by test 4) impact on MVP timeline/architecture 5) what it displaces. §5.2 lists what is NOT MVP (EHF, Asl Belgisi, Click/Payme, promotions, full logistics, returns, batches/FEFO, transfers, 2-way 1C, custom roles/report builder/open API, AI/forecast, native app). Out-of-scope ⇒ stop.

# Architecture (§10)
Modular monolith, no microservices. Modules: auth, users/rbac, customers, catalog, stock, orders, finance, field-sales, purchases, reports, integrations, audit, sync. Modules talk via service interface or domain event, never another module's DB internals. Stack stays NestJS/pnpm/Prisma/Postgres(RLS)/BullMQ/Next.js — no swaps without a real gap. Server is source of truth; cache never the source of money/stock truth.

# ADR defaults (§19)
001 keep current stack+PM2 · 002 Telegram Mini App + PWA, offline only on tested devices · 003 6 operational roles incl. ACCOUNTANT + separate platform admin (audit repo/DB first) · 004 1C format from real pilot config + CSV/XLSX · 005 UZS only, VAT configurable · 006 GPS 150 m with caveats · 007 offline cash = pending intent until server ACK + handover reconciliation · 008 UZ primary hosting until legal review · 009 prices are hypotheses · 010 no absolute "full offline" claim.
Ambiguity on money/stock/security/legal ⇒ safest option + recorded assumption + ask the user; never guess.

# Plan format & routing
Definition of Ready (§15.2): problem+role, business rule+edge cases, success test, UI/API/data impact, MVP status. Route steps to: `scout` locate · `db-rls` schema/RLS/seed · `api-dev` general API · `finance-stock` money/stock/orders · `integrations-dev` 1C/import/export/Telegram/jobs · `web-dev` web UI · `miniapp-dev` offline app · `i18n-sync` after role/string changes · `qa-engineer` tests · `reviewer` → `fixer` · `security-auditor` after auth/tenant/RLS changes · `checks` health · `devops` deploy/CI. Order: db-rls → api/finance → ui → i18n → qa → review → security → checks.
