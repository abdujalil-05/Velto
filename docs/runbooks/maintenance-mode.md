# Maintenance mode (read-only) - ADR-051
- **Detection (when to use):** planned migration/restore window, suspected data corruption, DB degraded but readable.
- **Severity:** operator-controlled; incident severity is that of the triggering event.
- **Triage / how:** set `READ_ONLY_MODE=true` in the production env and `pm2 restart velto-api --update-env`. Every POST/PUT/PATCH/DELETE then answers 503 `MAINTENANCE_READ_ONLY`, except routes marked `@AllowDuringMaintenance` (login/refresh/logout/Telegram login). Reads keep working. Turn off: `READ_ONLY_MODE=false` + restart.
- **Data safety:** Offline Mini App pushes get 503 and stay queued on the device (no loss); tell agents not to clear app data. Mode is a restart-time env flag (no runtime toggle endpoint verified). Background jobs that write (exports, reconciliation fix) are subject to the same guard only if they go through HTTP routes - verify before relying on it for job isolation.
- **Owner:** Ops owner / Tech Lead.
- **Verification:** `POST` on any business route -> 503 `MAINTENANCE_READ_ONLY`; `GET` and login OK; after disabling, a write succeeds.
- **Comms:** Announce window start/end beforehand; show the read-only notice to users.
