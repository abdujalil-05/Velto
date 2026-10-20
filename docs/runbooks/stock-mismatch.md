# Stock mismatch (StockLevel != sum(StockMovement))
- **Detection:** `GET /reconciliation/findings` (kind `STOCK`, status `OPEN`); scheduled reconciliation run (`reconciliation-schedule.processor`); restore-drill check "StockLevel = sum(StockMovement)". Formula: onHand = RECEIVE + ADJUST - ISSUE; reserved = RESERVE - RELEASE - ISSUE (signed qty; reversals compensate). Alert on mismatch count > 0: (planned).
- **Severity:** SEV2 (inventory integrity is a release gate); SEV1 if oversell is occurring.
- **Triage:** 1) `POST /reconciliation/run` for a fresh result. 2) Inspect the finding (expected vs actual). 3) Find the cause from `StockMovement` (append-only truth) + `AuditLog` by `traceId` - a StockLevel written without a movement is the usual cause. 4) Fix the cause (code/data path) before fixing the symptom.
- **Data safety:** StockMovement is append-only; NEVER edit it. The projection is repaired only with `POST /reconciliation/findings/:id/fix` (permission `reconciliation.fix`, recomputes StockLevel from movements, audited as `reconciliation.fix` with old/new values). Take a backup (`deploy/backup/backup.sh`) first if many rows are affected.
- **Owner:** Warehouse Owner + Tech Lead.
- **Verification:** run again -> finding closed, zero OPEN STOCK findings; physical count of sampled SKUs matches `onHand`.
- **Comms:** Warehouse/customer owner told which SKUs/warehouses were affected and that a recount may be asked.
