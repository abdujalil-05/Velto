# Offline device test matrix (pilot) — TZ §8.5 / §16.2

Manual test plan for pilot devices. Automated coverage: `apps/api/test/f4-offline-sync.e2e.test.ts`,
`apps/miniapp/src/lib/offline/f4-offline-qa.test.ts`. This matrix covers what automation cannot: real
radios, OS process killing, WebView storage policies.

**Known platform risk (ADR-010):** Telegram iOS WebView (WKWebView) may restrict or evict Service Workers and
IndexedDB (storage eviction after inactivity, SW not available/registered in some Telegram builds, no
persistent-storage grant). On iOS the offline shell may therefore fall back to online-only; the queue must
still never lose a PENDING document. Record every deviation under "Notes" and escalate to ADR-010.

## 1. Pilot device inventory (user-provided — fill in before the pilot)

| # | Agent | Phone model | OS + version | Telegram version | Browser (PWA) + version | Free storage | Notes |
|---|-------|-------------|--------------|------------------|--------------------------|--------------|-------|
| 1 |       |             |              |                  |                          |              |       |
| 2 |       |             |              |                  |                          |              |       |
| 3 |       |             |              |                  |                          |              |       |
| 4 |       |             |              |                  |                          |              |       |
| 5 |       |             |              |                  |                          |              |       |

Minimum coverage (TZ §8.5): at least one Android + one iOS device, current Telegram clients, and the PWA browser(s) used.

## 2. Environments (columns for every scenario)

- **A** = Android + Chrome (PWA / browser)
- **T-A** = Telegram Android (Mini App)
- **T-i** = Telegram iOS WebView (Mini App)

Run every scenario once on **normal network** and once on **slow 3G** (Chrome DevTools throttling is not enough on
real devices: use a throttled hotspot / Network Link Conditioner on iOS). Mark each cell: `[ ]` not run, `[x]` pass, `[!]` fail (+ note).

## 3. Scenarios

Setup for all: staging tenant with synthetic data, agent with a route of >= 5 outlets, first sync completed online
(cache ready), device storage > 500 MB free unless the scenario says otherwise.

### S1 Airplane mode, cold start (§8.5 #1, §16.2 #1)
Steps: sync online -> force-quit app -> enable airplane mode -> open app -> create 1 order + 1 visit.
Expected: app opens from cache (no blank screen); order/visit saved with "saqlandi qurilmada" status; queue shows PENDING; no data loss after another force-quit.

| Normal network | A | T-A | T-i |
|---|---|---|---|
| Result | [ ] | [ ] | [ ] |
| Slow 3G | A | T-A | T-i |
| Result | [ ] | [ ] | [ ] |

### S2 20 offline orders then reconnect (§8.5 #2, §16.2 #2)
Steps: airplane mode -> create 20 orders -> disable airplane mode.
Expected: queue flushes automatically in creation order; all 20 become SYNCED; server shows 20 orders with 20 distinct clientIds and 20 distinct SO numbers; no duplicates.

| Normal | A | T-A | T-i |
|---|---|---|---|
| Result | [ ] | [ ] | [ ] |
| Slow 3G | A | T-A | T-i |
| Result | [ ] | [ ] | [ ] |

### S3 Connection cut mid-sync (§8.5 #3-4, §16.2 #3-4)
Steps: enqueue 25 orders offline -> reconnect -> toggle airplane mode on after ~1-2 s (during sync) -> wait 1 min -> reconnect.
Expected: already ACKed orders stay SYNCED and are not re-sent; the rest continue; final server count = 25, no duplicates; no item stuck in SYNCING.

| Normal | A | T-A | T-i |
|---|---|---|---|
| Result | [ ] | [ ] | [ ] |
| Slow 3G | A | T-A | T-i |
| Result | [ ] | [ ] | [ ] |

### S4 Background kill during sync (§16.2 #4)
Steps: enqueue 20 orders offline -> reconnect -> immediately swipe the app away / let the OS kill it (Android: swipe + "kill"; iOS: swipe up; also lock screen for 5 min) -> reopen.
Expected: no item lost; leftover SYNCING items return to PENDING and are re-sent with the same clientId; server has exactly 20 orders.

| Normal | A | T-A | T-i |
|---|---|---|---|
| Result | [ ] | [ ] | [ ] |
| Slow 3G | A | T-A | T-i |
| Result | [ ] | [ ] | [ ] |

### S5 Triple resend / lost ACK (§8.5 #3)
Steps: enqueue 5 orders -> sync on a flaky link (hotspot that drops responses) so the same orders are sent 2-3 times.
Expected: server DUPLICATE for repeats; each order exists once on the server; queue ends SYNCED.

| Normal | A | T-A | T-i |
|---|---|---|---|
| Result | [ ] | [ ] | [ ] |

### S6 Price changed while offline (§8.5 #5, §16.2 #5)
Steps: create order offline -> an office user changes the product price -> reconnect.
Expected: item shows CONFLICT with old vs new total in plain words; price is NOT silently replaced; nothing auto-retried; after "accept new total" it syncs with the server price.

| Normal | A | T-A | T-i |
|---|---|---|---|
| Result | [ ] | [ ] | [ ] |

### S7 Customer blocked / stock gone while offline (§8.5 #6-7)
Steps: create order offline -> office blocks the customer (second run: stock sold out) -> reconnect.
Expected: item stays visible with a clear status (FAILED/CONFLICT reason in uz/ru), never silently dropped; other queued items still sync.

| Normal | A | T-A | T-i |
|---|---|---|---|
| Result | [ ] | [ ] | [ ] |

### S8 Storage near quota (§8.5 #8, §16.2 #7)
Steps: fill device storage (large files) until < 60 MB free, or use a 45+ MB cache -> create orders offline.
Expected: warning at 80% of the 50 MB budget; when the device is full creation fails with a clear error, existing PENDING items are intact and exportable; cache cleanup never deletes PENDING documents.

| Normal | A | T-A | T-i |
|---|---|---|---|
| Result | [ ] | [ ] | [ ] |

### S9 Logout / revoke / shared device (§16.2 #7)
Steps: (a) logout with unsynced items; (b) admin deactivates the agent while offline items exist, agent reconnects; (c) second agent logs in on the same device.
Expected: (a) logout blocked with a count and export option, forced path wipes only own rows; (b) sync pauses with a clear message, nothing written server-side, items kept; (c) second user never pushes the first user's items.

| Normal | A | T-A | T-i |
|---|---|---|---|
| Result | [ ] | [ ] | [ ] |

### S10 Token expiry during sync (§16.2)
Steps: leave app > 15 min idle with queued items (access token expired) -> reconnect.
Expected: one silent refresh, queue resumes, nothing lost; if the refresh token is also dead, sync pauses and asks to sign in again, items kept.

| Normal | A | T-A | T-i |
|---|---|---|---|
| Result | [ ] | [ ] | [ ] |

### S11 Service worker / IndexedDB persistence (ADR-010)
Steps: install/open, sync, close app, leave 3-7 days unused (iOS eviction window), open offline.
Expected: record whether the SW is registered, whether IndexedDB survived, and whether the persistent-storage request is granted. If data was evicted: agent sees a "resync required" state, no PENDING data is silently lost (PENDING must be exported/synced before long inactivity).

| Check | A | T-A | T-i |
|---|---|---|---|
| SW registered | [ ] | [ ] | [ ] |
| IndexedDB survived 3 days | [ ] | [ ] | [ ] |
| IndexedDB survived 7 days | [ ] | [ ] | [ ] |
| navigator.storage.persist() granted | [ ] | [ ] | [ ] |

### S12 Performance feel (NFR-PERF-004..006)
Steps: first full catalog sync (pilot-size catalog) on slow 3G and on normal network; push 20 queued orders.
Expected (guidance, record actual): full sync completes without freezing the UI; push of 20 orders finishes in a few seconds on normal network; UI stays responsive.

| Metric | A | T-A | T-i |
|---|---|---|---|
| Full pull time (normal) | | | |
| Full pull time (3G) | | | |
| Push 20 orders (normal) | | | |
| Push 20 orders (3G) | | | |

## 4. Sign-off

| Date | Tester | Devices covered (#) | Blocking failures | Decision |
|------|--------|---------------------|--------------------|----------|
|      |        |                     |                    |          |
