# Stale 1C export
- **Detection:** `GET /export/1c` shows jobs in `QUEUED`/`PROCESSING`/`FAILED` older than expected, or the accountant reports 1C has no fresh file; jobs not acknowledged via `POST /export/1c/:id/ack`. Automatic stale-source alert: (planned).
- **Severity:** SEV3 (SEV2 if month-end close is blocked).
- **Triage:** 1) `GET /export/1c/:id` for status + `errorLog`. 2) `QUEUED` too long => Redis/queue issue (degraded-redis.md); the in-process sweep (`export-1c-recovery.service`, every 5 min; stale thresholds 15 min, abandoned QUEUED > `ABANDONED_QUEUED_MS`) re-enqueues or fails it. 3) `FAILED` => fix cause (S3/MinIO reachability, data), then the user starts a new export. 4) File exists but not imported on the 1C side => re-download `GET /export/1c/:id/download` (check SHA-256 header).
- **Data safety:** Exports are read-only snapshots of finance data; never edit ledger rows to "fix" an export. Do not ack a job that 1C has not imported (duplicate/missing accounting posting).
- **Owner:** Integrations owner; Customer Accountant for the 1C-side import.
- **Verification:** new job `DONE`, downloaded hash matches `fileHash`, accountant confirms import, ack recorded.
- **Comms:** Tell the customer Accountant: which period/job is affected and the re-export ETA. Do not promise real-time 1C.
