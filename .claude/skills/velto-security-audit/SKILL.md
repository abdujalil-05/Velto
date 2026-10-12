---
name: velto-security-audit
description: Velto security audit checklist from TZ v4.0 §10.4/§11/§16.3; preloaded by the security-auditor subagent.
---

Legacy SEC-xxx ids in code map to §11 (auth→11.1, authz/tenant→11.2, data→11.3, audit→11.4) and §10.4 (RLS).

Checklist (priority order)
1. Tenant isolation: every new tenant table has RLS + FORCE + isolation test; DB access only via `withTenant`/`TenantPrismaService`; `companyId` never from body/query/header; pool does not leak context; tests use app role. Check export, import, file download and background jobs for tenant scope too.
2. `systemPrisma`: only phone login, platform provisioning, cross-tenant jobs; must drop to tenant client once `companyId` is known.
3. AuthZ: every non-`@Public()` route has `@RequirePermission`; permissions read from DB per request not JWT; IDOR (id from request without ownership check, agent seeing others' customers); `@Public()` routes expose no tenant data; PLATFORM_ADMIN/support access default-deny, time-boxed, reasoned, audited; errors don't reveal other tenants.
4. Auth: Argon2id hashes; short access token; refresh rotation + reuse detection ⇒ revoke token family; login rate-limit by user/IP/tenant; Telegram `initData` HMAC + `auth_date` freshness + replay; logout/logout-all revoke; refresh token never JS-readable.
5. Audit: denials, payments, allocations, stock adjustments, order confirm/cancel, role changes, import/export logged; append-only trigger intact; no passwords/tokens/OTP/bot token in audit or logs.
6. Secrets/data: no secrets in repo/logs/responses; uploads validate MIME/extension/size, no trusted filename, signed URLs with expiry; miniapp IndexedDB data encrypted per-row and decrypted rows never logged ("encrypted" alone is not proof — key handling matters).
7. AppSec: DTO whitelist, parameterised SQL, CSP, XSS/CSRF/SSRF, dependency + secret scanning; critical/high = release blocker.
8. Legal (§11.5): flag new personal-data fields (employee GPS, contacts) or new subprocessors/hosting outside UZ — needs data-inventory/legal review, not a code verdict.
