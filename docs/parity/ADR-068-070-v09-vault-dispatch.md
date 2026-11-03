# ADR-068..070 — PO v0.9: offline vault P0, assign ≠ dispatch, return to warehouse

Date: 2026-11-03 · Branch `feat/approved-decisions` · Source: PO prompt 2026-11-03 (items 1–3).

## ADR-068 — Offline orders/visits only under the owner's vault key (P0)

**Context.** Before this change, Mini App orders/visits were queued under a shared device key. Its raw key sat in `localStorage["velto.dbKey"]`. Payments already used the personal vault: a UK per user and company, wrapped with AES-KW by a KEK. The KEK is an HMAC derived on the server, issued by `GET /auth/offline-kek` and never persisted. If sealing failed on session end, unsynced docs stayed readable by anyone on the device. The PO does not accept this risk for the pilot.

**Decision.**
- New orders/visits are encrypted with the owner's vault UK, exactly like payments. There is no device-key fallback. If the vault is closed, the save is blocked with a clear message. Form data stays in memory and is never silently dropped.
- Logout, session expiry, forced invalidation, account switch and company switch all drop the in-memory UK. Rows stay sealed. They are never deleted.
- After confirmed auth, the owner's legacy device-key rows are sealed into the owner's vault. `velto.dbKey` is deleted as soon as no device-key rows remain.
- Legacy rows owned by another user follow an explicit blocking flow. The app shows a neutral message only: no count, contents or identifiers. Another user cannot start offline work on the device until the owner signs in and seals them. Rows are never deleted or reported as recovered.
- No new crypto system and no new libraries.

**Residual.** Rows written by a pre-fix build stay readable with `velto.dbKey` until their owner signs in on that device. This applies only to devices that ran a pre-fix build. The pilot starts on the fixed build, so such rows should not exist.

## ADR-069 — Courier assignment does not ship; handover is a separate operation (P1)

- `assign-courier` (`orders.assignCourier`) is allowed only in CONFIRMED and does not change the status. Repeating it with the same courier is a no-op.
- `POST /orders/:id/handover` uses the new `orders.dispatch` permission (OWNER, WAREHOUSE). It moves CONFIRMED with a courier to SHIPPED and is audited.
- Reassigning after SHIPPED goes only through: return to warehouse → assign → handover.
- Delivering an order that has a courier requires SHIPPED. CONFIRMED without a courier keeps the existing direct delivery.
- The financial logic is unchanged: stock issue and invoice happen on DELIVERED.

## ADR-070 — `orders.returnToWarehouse` (P1)

- Roles: OWNER, SALES_DIRECTOR, WAREHOUSE. It no longer depends on `orders.assignCourier`.
- SHIPPED → CONFIRMED. The courier is cleared and the reservation is kept. A reason is mandatory. The first return is audited.
- Returning from DELIVERED is forbidden. A repeat makes no second change.
- After a return, the order can be cancelled under the existing rules.

## Permission rollout

Both new permissions are data, not a migration. They are added through the idempotent backfill (dry-run by default). On `velto_dev`, only a dry-run is allowed. `--apply` is allowed only on a disposable test DB.

## Ownerless / foreign legacy rows (fail-closed)

- Pre-v3 queue rows have no `userId`/`companyId` and sit under the shared device key. A payload field (`agentId`/`userId`/`createdBy`) is NOT a proof of creator (unauthenticated, plaintext-equivalent, forgeable on a shared device), so nobody inherits such rows: no decrypt, list, export, push or auto-claim by any user. `claimLegacyEntries` and the per-creator quarantine list/export/discard were removed.
- Detection uses plaintext owner columns only (never decrypts): any device-key row whose owner is missing or differs from the signed-in user/company turns on `ForeignLegacyGate` (neutral text, no count, ids or content) and blocks creating new documents. Rows are never deleted by logout, expiry, user switch or revoke.
- Verified owner = a row carrying `userId`+`companyId` that match the signed-in session; its bring-up re-encrypts it under that user's vault key (AAD-bound). No such proof exists for ownerless rows.
- Recovery for ownerless rows: no in-app unlock and no automatic path, by design. Until a support runbook is approved by PO (P1, before pilot), the only allowed action is to leave the device blocked and the rows preserved. The future runbook must at least: be scoped to one tenant (the device's company proven by the device's last authenticated session, not by payload fields); require written approval from that company's OWNER plus a second person; never re-attribute a document to a user without that user's confirmation; record every step in AuditLog; and clear rows only after the documents are re-entered and reconciled. Pre-fix builds were not used in the pilot, so such rows are not expected.
