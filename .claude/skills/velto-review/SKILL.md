---
name: velto-review
description: Velto code-review checklist (conventions + TZ business rules + scope creep); preloaded by the reviewer subagent.
---

Findings (must point at a line):
- Logic: null/empty, Decimal rounding, off-by-one, unawaited promise, wrong transaction boundary, check-then-act without lock.
- Repo rules: `throw new Error()` instead of AppException; missing uz/ru/en; DB access outside `TenantPrismaService`/`withTenant`; `companyId` from client; missing `@RequirePermission`; Float/JS-number money; update/delete of append-only rows (StockMovement, Payment, AuditLog); side effect mid-transaction instead of `afterCommit`; hardcoded UI string or key missing in one locale; Dexie schema drifting from `/sync/pull`; plaintext write to IndexedDB.
- TZ business rules: client-trusted totals/prices (§6.6); stock available = onHand − reserved, reservation without lock (§6.4); payment allocation sum > payment or not FIFO, delete instead of reversal (§6.5); status transition skipping state machine or audit (§6.3); queue item removed before ACK, `updatedAt`-only pull cursor, silent price swap (§8); 'saved' wording ambiguous between device and server.
- Scope creep (§0.2.3, §5.2): any out-of-MVP model/endpoint/UI placeholder/TODO/feature flag (EHF, Asl Belgisi, Click/Payme, promotions, returns, FEFO, transfers, 2-way 1C, custom roles, AI) is a finding.
- Missing test for money/stock/tenant/permission/sync change (§15.3 DoD) is a finding only when the changed code is one of those.
Not findings: style, naming taste, speculative refactors, generic "add tests".
