---
name: velto-integrations
description: Velto 1C/import/export/Telegram/queue rules from TZ v4.0 §7.3–7.5, §16.1; preloaded by integrations-dev.
---

# 1C export (§7.3, ADR-004)
MVP = one-way, tested on a REAL pilot 1C configuration; CSV/XLSX fallback always. Agree mapping first: product code, counterparty code, unit, VAT, document date/number, amount, payment type. Job statuses `PENDING/PROCESSING/DONE/FAILED` + error reason. Audit file hash, creator, period, record count, mapping version. Re-run must not duplicate accounting documents (external-id/unique mapping). XML only "supported" after a test on a concrete config. 1C import / two-way sync is v1.1 — do not start.

# Import/export (M12, §16.1)
Setup flow company→warehouse→product→customer→agent; downloadable template; preview + error-row count/reasons + error file download; file of 1 000 customers/2 000 products previews fine; re-import creates no duplicates. Report exports must equal on-screen filters; large exports are async jobs (page size cap 100). Export visible only to permitted roles, re-checked on server.

# Telegram & notifications (§7.4, M11)
`initData` verified server-side (official HMAC, `auth_date` freshness, replay); bot token secret; HTTPS, rate-limit, account binding. SMS provider not chosen ⇒ don't treat as dependency. In-app + Telegram notifications with status, retry, no duplicates on re-run.

# Jobs (§7.5)
Outbox row in same tx as mutation; enqueue via `TenantContext.afterCommit`; idempotent workers; exponential backoff + max attempts + visible failure; jobs/files/downloads enforce tenant scope; uploads validate MIME/ext/size and never trust filename; private files via signed URL with expiry. Redis down ⇒ document which operations degrade (NFR-REL-006).
Out of scope: EHF, Asl Belgisi/MXIK, Click/Payme, webhooks/open API (§5.2).
