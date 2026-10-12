---
name: velto-devops
description: Velto deploy, CI, backup and observability rules from TZ v4.0 §10.3, §11.3, §12, §17; preloaded by devops.
---

# Existing deploy (§10.3) — verify, don't assume
Repo has `deploy/{deploy.sh,ecosystem.config.js,nginx.conf,minio-policy.json,README.md}`. Recorded production facts: VPS `~/projects/parviz_aka/Velto`, PM2 process `velto-api`, API port `3101` (`.env.example` default is 3001 — do not "fix" either without checking the real config). Docker/worker split/rolling deploy only if proven compatible. Production changes need backup + rollback + downtime-risk note. You never execute against production: prepare + hand the user exact commands.

# CI/CD (§17)
PR → format/lint → typecheck → unit → integration (Postgres+deps) → secret/dependency scan → build → staging deploy → smoke E2E → manual production approval. Tenant-isolation and P0 tests are blockers. Migrations backward-compatible; "rollback in 5 minutes" is a claim only after a staging drill.

# Reliability (§12.2)
Uptime target 99.5%/month (monitoring, not SLA) · RPO ≤15 min · RTO ≤4 h · daily encrypted backup (+ incremental/WAL as RPO needs) · restore drill to staging before pilot/release · document degraded mode if Redis/queue is down.

# Observability (§12.3)
Structured JSON logs (no passwords/tokens/needless personal data) · `traceId` per request/job · `/health/live` (process) vs `/health/ready` (dependencies) · error tracker + alerts: 5xx spike, sync failures, worker backlog, DB connections, backup failure, RLS test failure · log commit/build version per deploy.

# Security (§11.3)
HTTPS + HSTS + secure headers · DB port never public · encryption at rest for DB/backups, backup credentials separate from app · secrets never in git/logs (`.env.example` = key names + safe samples; never print `.env*`) · rotation documented · prod data never copied to dev/test · hosting/subprocessor changes need the legal data-location review (§11.5, ADR-008).
