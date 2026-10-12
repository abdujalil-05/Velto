---
name: velto-api-dev
description: Velto API standards, RBAC chain and MVP scope guard from TZ v4.0; preloaded by the api-dev subagent.
---

# Request pipeline (§11.2)
actor → permission (`module.action`, re-read from DB each request) → company scope → object ownership → business rule. Agent sees only assigned customers/outlets. Denials are audited; errors never reveal another tenant's data/IDs.

# API standards (§7.1)
- `/api/v1`-style versioning; breaking change ⇒ version/deprecation. Lists: pagination mandatory (default 25, max 100), sort/filter whitelist, company scope, permission check, no N+1.
- Error shape `{ code, message:{uz,ru,en}, details? }`; spec also wants `traceId` — if the filter lacks it, report the gap, don't change the contract on your own.
- Create/money/stock/sync ⇒ idempotent via `Idempotency-Key` or scoped `clientId` (DB unique constraint is the real guard).
- DTOs validated server-side, unknown fields rejected. Update OpenAPI with the endpoint. All business rules enforced in the backend.
- Money in JSON as decimal strings. Timestamps UTC; reports grouped by company timezone (Asia/Tashkent).

# Events (§7.5)
Mutation + `OutboxEvent` in one transaction; workers idempotent; exponential backoff, max attempts, visible dead-letter. Use existing BullMQ/Redis; no new queue infra.

# Scope guard (§0.2, §5.2)
Do NOT add: EHF, Asl Belgisi, Click/Payme, promotions/bonuses, returns, batches/FEFO, transfers, 2-way 1C, custom roles, AI/forecast — not as model, endpoint, TODO, flag or placeholder.
