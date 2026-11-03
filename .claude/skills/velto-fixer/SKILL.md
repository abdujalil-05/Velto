---
name: velto-fixer
description: Minimal-fix protocol and block conditions for Velto; preloaded by the fixer subagent.
---

Protocol: open only the cited file around the cited line → confirm the defect exists as described → smallest edit → typecheck/single vitest → report.

Block (do not improvise) when the fix needs: a migration or RLS policy; a new endpoint/DTO contract; a role/permission change; any out-of-MVP feature (TZ §5.2); a business-rule decision on money/stock/debt.

Keep while fixing: AppException (uz/ru/en), TenantPrismaService, Decimal money, all three locale files, append-only tables never updated, `afterCommit` for side effects. Never reformat untouched lines; never rename.
