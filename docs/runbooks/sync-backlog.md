# Sync backlog (offline Mini App)
- **Detection:** agents report documents "pending"; spike of 4xx/5xx or timeouts on `POST /sync/push` / `GET /sync/pull`; growing client queue (miniapp `src/lib/offline/queue.ts`). Backlog-age alert: (planned).
- **Severity:** SEV2 if many agents blocked; SEV3 for a single device.
- **Triage:** 1) `/health/ready`. 2) `pm2 logs velto-api` filtered by `/sync/` and a `traceId` from the client. 3) Push timeouts => batch too big for the 5 s request transaction: `SYNC_PUSH_MAX_BATCH` (default 20, hard cap 100) - lower it and restart. 4) Conflicts: items get explicit conflict/ACK results; unresolved ones stay in the client queue (no silent drop).
- **Data safety:** Push is idempotent by `clientId`; clients may retry safely. Never delete queue rows or IndexedDB data on a device before the item has a terminal ACK. Do not restart the API in a loop during peak sync.
- **Owner:** Field Operations lead + Tech Lead.
- **Verification:** `GET /sync/pull` cursor advances; the test device drains its queue; no orders duplicated (unique `clientId`); `POST /reconciliation/run` clean.
- **Comms:** Tell agents to keep the app open on a stable network and NOT clear app data / reinstall until the queue shows empty.
