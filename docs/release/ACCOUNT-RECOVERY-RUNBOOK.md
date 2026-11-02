# Account recovery without SMS (pilot)

Context: without `SMS_API_TOKEN` the password-reset request returns 503 `SMS_NOT_CONFIGURED`; production never logs phone or code. Recovery is manual and human-verified.

## User (non-owner) forgot password
1. Verify identity out-of-band (known phone call / in person by OWNER; never via the same chat the request came from). Record who/when in the ops log (no passwords).
2. OWNER sets a new password via `PATCH /users/:id` (password field) in the web UI/API; share it out-of-band, user changes it at first login. Audit row: `user.update`.

## User lost MFA device
OWNER calls existing step-up endpoint `POST /users/:id/mfa/reset` (requires OWNER's own step-up), after the same identity check.

## OWNER lost own password
OPEN (PO decision): there is no in-app path. The operator procedure must be defined by the PO. Do NOT use ad-hoc DB edits or RLS/role bypass.

## Known gaps (all OPEN)
- No dedicated audit action/reason for an admin password reset (only generic `user.update`).
- No step-up required for admin password reset (MFA reset has it).
- Revocation of the target user's sessions/refresh tokens on admin password change is not verified.
- Not exercised on a server; this runbook is untested.
