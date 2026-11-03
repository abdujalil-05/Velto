# ADR-065: temporary exception to signed URLs, private files streamed through the API (closed pilot v0.9 only)

Status: ACCEPTED by PO 2026-11-02, **temporary**. Scope: closed pilot v0.9 only. Must be revisited before GA.

## Context
TZ v5.0 (§11, line ~1034 and ~734/~1562) requires signed URLs with expiry for private file access.
Velto does **not** implement signed URLs. Private files (1C exports, company exports, import/opening
sources, report and aging exports) are never given to the client as S3 URLs. The client downloads
them as a stream through the authenticated API.

## Decision
For the closed pilot, keep streaming through the API and do not add a presigner now. This is an
exception to the TZ requirement. **It does not mean signed URLs are implemented.**

## Conditions the exception depends on (verified 2026-11-02, e2e `apps/api/test/private-download-session.e2e.test.ts` and existing download e2e tests)
| Condition | Mechanism |
|---|---|
| Valid session on every download | `JwtAuthGuard` + `@PrivateDownload()` → `@RequireActiveSession` check of `sid` against `RefreshToken` in `TenantContextInterceptor` (shared helper `common/auth/session-active.ts`, also used by `/auth/offline-kek`) |
| Access stops after session revocation | logout / logout-all → same access token → 401 `AUTH_SESSION_EXPIRED` + audit `auth.session_revoked_denied` |
| companyId + object ownership | job row looked up under RLS (`withTenant`) before reading S3; storage key is tenant-prefixed, `..` rejected (`storage.service.ts`) |
| Current RBAC | `@RequirePermission`, re-read from DB per request (mid-token revoke → 403 + audit) |
| No public persistent links | bucket policy grants anonymous read on `products/*` only, no ListBucket (`deploy/minio-policy.json`); private keys are UUID/jobId under tenant prefix; `ImportJob.fileUrl` no longer returned by the API |
| Not publicly cached | `Cache-Control: private, no-store`, `Pragma: no-cache` on successful download responses |
| Download and denial audited | success audit per endpoint; 403 audited by interceptor; foreign/missing jobId → audit `export.download_rejected` / `company.export.download_rejected` (written after the request tx rollback) |
| No cross-tenant leakage in errors | identical 404 for foreign and missing job id |
| No direct-S3 bypass | anonymous GET on non-`products/` prefixes → 403 (verified on SeaweedFS, matrix row 15) |

## Known limits (accepted for pilot, not for GA)
- Revoked-session check applies to download routes only, not globally (≤15 min access-token window remains on other routes). A global check is feasible (one indexed SELECT per request) and is proposed as a separate change after a full-suite run.
- `no-store` is set on 200 responses only. 401/404 responses on these routes have no body with private data.
- Throughput: large files go through the API process (pilot volume only).
- No automated deploy-time check that the bucket policy has no ListBucket or wider public read (manual step in `deploy/README.md`).

## Revisit before GA (any of these reopens the decision)
- GA release or any non-closed (public) tenant onboarding.
- Need to offload large downloads from the API, or a CDN.
- Any finding that one of the conditions above is broken.
GA options: short-TTL presigned GET issued only after the same session/RBAC/ownership checks + audit, or keep streaming with the global session check. Either way the TZ text or an ADR must be updated.
