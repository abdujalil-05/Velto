---
name: velto-miniapp-dev
description: Velto offline/sync rules, mini-app UX and GPS policy from TZ v4.0 §8–9; preloaded by the miniapp-dev subagent.
---

# Platform (§8.1)
IndexedDB/Dexie is the offline DB (Telegram DeviceStorage is only 5 MB — never use it for catalog/queue). First launch needs internet to download assets/permissions/data. Browser may wipe storage ⇒ warn next to unsynced docs and keep a recovery/export path. Nothing is "saved on server" until server ACK.

# Local data (§8.2)
Products, packaging, prices, assigned customers/outlets, route, last-known stock/balance; offline orders, visits, payment-collection intents; queue rows `{clientId, entityType, schemaVersion, createdAt, attempts, lastError, status}`. Always show "Oxirgi yangilanish" next to stock/debt. Minimise stored personal/financial data; logout/device change/revoke tested.

# Sync (§8.3)
- `clientId` = UUID generated once, constant across retries. Push batch ≤20 (configurable); each item independent: `ACCEPTED|DUPLICATE|CONFLICT|REJECTED|RETRY`. `DUPLICATE` ⇒ success. Remove from queue only after ACK; store server id + final status.
- Pull uses server cursor/monotonic sequence, never `updatedAt` alone.

# Conflicts (§8.4)
Price changed ⇒ never silently swap; show new total, require confirm/resend. Stock gone ⇒ keep as CONFLICT/SUBMITTED or explicit reject (reservation is server-side only). Customer blocked / agent revoked ⇒ doc stays visible with reason. Partial sync ⇒ only ACKed items synced. Quota full ⇒ warn early, never auto-clear pending queue (old cache may be evicted). Phone restart ⇒ queue restored.

# UX (§9.3)
Home: route completion, pending-sync count, Marshrut/Buyurtma/Kunlik natija. Order flow: customer → product → qty → review/save (no extra form steps); repeat previous order. States: Saved on this device / Waiting to sync / Synced / Needs attention. Payment: open invoices, FIFO preview; offline cash is a separate pending intent (not "cashier received").

# GPS (§9.4)
150 m default radius is config; server recomputes distance (client `gpsOk` is not truth); no coords ⇒ `gpsOk=null`, don't block. Distinct messages: permission denied / low accuracy / no coordinates / outside radius. Spoofing is not prevented — never claim it.

# Perf (NFR §12.1)
Offline catalog search p95 ≤150 ms · local order save p95 ≤300 ms · 100 pending docs sync ≤30 s. Required tests: airplane-mode save, 20 offline orders, triple resend, mid-sync cut, stale price, quota full.
