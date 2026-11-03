# Offline KEK rotation (`OFFLINE_KEK_SECRET`)

- **What it protects:** each Mini App agent has a per-user+company vault key (UK) on the device, wrapped (AES-KW) by `KEK_v = HMAC-SHA256(secret_v, "velto-offline-kek:v<v>:<companyId>:<userId>")`. Held/pending offline payments are encrypted under UK. The root secrets never leave the API; the client only receives its own derived KEK from `GET /auth/offline-kek` (live session, per-user Redis rate limit 10/min, fail-closed, `no-store`, audited without key material).
- **Env:** `OFFLINE_KEK_SECRET` = current secret, `OFFLINE_KEK_VERSION` = its version (default 1), `OFFLINE_KEK_PREVIOUS_SECRETS` = `"<ver>:<secret>;..."` for retired-but-still-readable versions (validated at boot: lower than current, unique). Secrets live only in the server env / secret store — never in the repo, logs or AuditLog.
- **Rotate:**
  1. Generate a new secret (same strength rule as the current one) in the secret store.
  2. Deploy with `OFFLINE_KEK_VERSION=N+1`, `OFFLINE_KEK_SECRET=<new>`, `OFFLINE_KEK_PREVIOUS_SECRETS="N:<old>;..."` (keep every older entry still listed).
  3. On each agent's next online login the app fetches `?version=N` to unwrap its UK and re-wraps it under N+1. No payment data is re-encrypted; nothing is lost.
  4. Watch AuditLog `auth.offline_kek.issued` with `version < current`: while such requests appear, devices still depend on the old version.
  5. Remove an old version from `OFFLINE_KEK_PREVIOUS_SECRETS` only per the pilot rule below. Never remove automatically.
- **AuditLog is not proof.** Absence of `version < current` requests only shows that no device *asked* recently. A device that stayed offline (or was switched off) still holds a UK wrapped under the old version and may hold unresolved payments; the server cannot see them (no per-device inventory).
- **If an old version is removed too early:** the endpoint answers 410 `OFFLINE_KEK_VERSION_RETIRED`; the device keeps the records locked (never deleted) and shows a warning. Recovery = put the version back into `OFFLINE_KEK_PREVIOUS_SECRETS` and redeploy.
- **Secret leak:** rotate as above; a leaked secret plus a stolen device can open that device's records, so treat it as an incident (`bot-token-leak.md` pattern).
- **Pilot rule (v0.9, closed pilot — binding):**
  - Rotation is an incident action only (suspected secret leak) and needs written PO + Tech Lead authorization; no scheduled/unsanctioned rotation.
  - During the pilot **no version is ever removed** from `OFFLINE_KEK_PREVIOUS_SECRETS`. Removal is allowed only after the pilot ends **and** every device on the pilot device list has been checked in person: logged in online on the current build (audit `auth.offline_kek.issued` at the current version for that user) and its outbox/held records show zero unresolved payments; Tech Lead signs off per version.
  - A device not on the list or not checked = still dependent → keep the version.
  - Key material: the master secret never leaves the server; the client receives only its own derived KEK. Never paste secrets/KEKs into tickets, chat, logs or AuditLog.
  - If an old version is unavailable on a device: records stay locked, never auto-deleted (ciphertext is kept); restore the version and redeploy.
- **Operational limitation (accepted for MVP):** no automatic per-device inventory of key versions or offline records; safe removal of old versions is therefore not automated and is not confirmed — treated as an operational restriction, see pilot rule.
