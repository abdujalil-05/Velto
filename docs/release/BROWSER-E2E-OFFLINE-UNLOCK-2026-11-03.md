# Browser E2E — Offline Unlock (ADR-071), 2026-11-03

**Tool:** Playwright 1.59.1 + Chrome for Testing 156.0.8078.4 (cached `chromium-1248`, `executablePath`), headless, `launchPersistentContext` with a fresh isolated test profile per run. Claude in Chrome: no connected browser (checked once), not used. No personal Chrome profile, cookies or real accounts.
**Real, not mocked:** IndexedDB (Dexie), service worker + CacheStorage, Web Crypto (AES-KW/AES-GCM), Argon2id (hash-wasm WASM in a Worker).
**Stand:** isolated docker Postgres :5435, DB `velto_e2e20261103b_test` (synthetic seed, 2 companies), Redis :6381, API :3004 (`nest build`), miniapp :3024 (`next build` + `next start`). velto_dev / :5433 untouched.
**Users (synthetic):** A and B = sales agents of company 1, C = agent of company 2. Miniapp login is Telegram-only, so the session was placed through the existing PWA-resume path (tokens from `POST /auth/login` into localStorage); no server auth change. Passphrases, passwords and tokens are not in this file or in the evidence (grep over evidence: 0 hits, no `eyJ`).
**Offline:** `context.setOffline(true)` plus, for cold start, API and miniapp server processes stopped, so the shell can only come from the SW cache. Cold start = close the browser context, relaunch with the same profile, `page.goto` — not a reload of an open page.

## Runs
| Run | Result | Finding |
|---|---|---|
| r1 (profile-A) | core flow PASS | **F1 (P1):** any client navigation in local mode hard-reloads the document → in-memory UK lost → unlock screen on every page |
| r2 (profile-A2) | F1 FAIL, new **F3 (HIGH)** | first SW fix (RSC fallback) did not cover link prefetch; network loss + client navigation re-ran auth bootstrap / vault bring-up and **wiped the IndexedDB reference cache** (customers 49→0, products 120→0, prices 240→0) |
| r3 (profile-A3) | **51 PASS / 0 FAIL** | — |

## Root causes and fixes (F1, F3)
- F1: `public/sw-logic.js` classified RSC navigations and `Next-Router-Prefetch` as `bypass`; offline they failed and Next fell back to MPA navigation. `/report` was not in the warmed core routes. Fix: `rsc` kind (navigation + prefetch; segment-prefetch stays bypass), network-first with abortable deadline, fallback to a full-tree payload of the exact same pathname warmed on `WARM_SHELL`; redirected/non-200 responses never cached; cache `velto-shell-v3`.
- F3: a full-tree payload gives next-intl new props → new `useTranslations()` identities → `auth-context.tsx` / `sync-engine.tsx` effects with translators in deps re-ran (offline → `offline-locked`; `bringUpVault` → `dropDeviceKeyIfUnused` → cache wipe). Fix: translators via refs; the device-key cleanup wipe runs only on the first online bring-up (never offline, in local mode, or when the owner's UK is already active — `isVaultActiveFor`, per owner).
- Regression tests: `src/lib/offline/cache-failsafe.test.ts` (3), `src/lib/offline/sw-logic.test.ts` (rsc/prefetch/redirect/core routes).
- ADR-071 addendum: core routes must stay static/client-only (no `cookies()`/`headers()`/auth in server components) because the shell/RSC cache is not wiped on logout/revoke.

## r3 scenarios (all PASS)
| # | Scenario | Observed |
|---|---|---|
| 1–3 | Online login A; enable Offline Unlock in Settings; passphrase (weak rejected "Не менее 12") | enrolled, ~1.1 s |
| SW | Shell + RSC warmed | `velto-shell-v3`: 85 entries, 24 RSC |
| 4–5 | Offline order | toast "Заказ сохранён на устройстве (на сервер ещё не отправлен)"; Dexie row PENDING, userId/companyId = A, `_enc {iv, ct, v:'uk1'}`, no plaintext |
| 6–8 | Relaunch, offline (API + miniapp stopped), cold start | shell 200 from SW, "Разблокировать офлайн" |
| 9 | Local unlock | 0.6–1.2 s (Argon2id) |
| F1 | Chain home→ЗАКАЗ→save→route→real route outlet visit→payment/new→save→queue→settings→home in ONE unlock | 10 steps, 0 document loads, never re-locked; per-link ЗАКАЗ/МАРШРУТ/ОТЧЁТ/Очередь client-side |
| 10–11 | Read saved docs in queue; second order | "Не отправлено (4)", "Только на этом устройстве" |
| V/P | Offline visit on a real route outlet; offline payment | toasts "Визит сохранён на устройстве…", "Платёж сохранён…"; PENDING under A, sealed |
| 12 | Relaunch offline again | locked, 4 PENDING kept |
| 13 | Wrong passphrase | "Неверный пароль. Осталось попыток: 9.", failCount +1, immediate retry "Слишком много попыток." (backoff 2 s·2^(n−1) stored in entry); correct after backoff → failCount 0 |
| 14 | User B: no entry → "офлайн-доступ не включён", no A form; A's entry copied under B's key: neither A's nor B's passphrase opens it (owner-bound KDF secret); A's entry and queue untouched | 0 API requests |
| 15 | Local mode with network back: no auto requests for 8 s; server session expired → Reconnect | "Сессия истекла. Войдите заново.", entry + 4 PENDING kept, 0 docs on server |
| 17b | Unlocked as A, tokens swapped to B, Reconnect | nothing pushed (no `/sync/push`, 0 docs on server), B signed in as B with empty queue |
| 16–18 | Reconnect as A (`/auth/me` == owner) → sync | auto push ~32 s; DB: SalesOrder ×2 agentId=A, Visit ×1 agentId=A, Payment ×1 collectedBy=A (PENDING_HANDOVER), AuditLog order.create userId=A |
| 19 | Duplicates after extra retry/reload | by clientId: orders 2, visit 1, payment 1, duplicate groups 0 (A orders 147→149) |
| 20 | B and C access | B: `GET /orders/{A}` 404, B lists (plain / agentId=A / status) contain none of A's ids; C (company 2): 404, no A ids; B UI queue empty |
| F3 | Online session → setOffline → router.push + link clicks; plain offline reload | no "Нет связи", 0 reloads; cache customers 50 / products 120 / prices 240 before = after |
| L | Legacy ownerless PENDING row | stays PENDING, never pushed; gate "Документы на этом устройстве заблокированы" |

## Security checks
- Local mode: 0 requests to the API during unlock, orders, visit, payment, wrong passphrases and 8 s idle with the server reachable; local unlock creates no server session.
- `offlineUnlock` entry: `fmt`, `wrappedUK` (40 B), `salt` (16 B), `params`, sealed `profile` only. No passphrase, derived key, raw UK, tokens or plaintext documents in IndexedDB / web storage.
- CacheStorage (48 HTML/RSC bodies, 1.5 MB, online and after local-mode use): 0 hits for A's name, phone, companyId, userId, token prefixes, customer names.
- Server-side owner re-check not bypassable (17b); pending queue survives network loss, session expiry and relaunch.
- Reviewer PASS (LOW only), security-auditor PASS (LOW only) on the final diff.

## Not verified / limits
- Real Telegram WebView / `initData` login, Android and iPhone devices (WebView memory for Argon2id 64 MiB, SW support in Telegram WebView, storage eviction). Argon2 parameters not benchmarked on low-end Android.
- Dynamic `/delivery/[id]` (courier) is not warmed: offline navigation there still hard-reloads.
- After a deploy, a cached payload with an old buildId makes Next do an MPA navigation until the next online start re-warms the cache.
- No user-facing "different account" message when tokens change to another user before Reconnect (vault locks silently; nothing is pushed).
- `localStorage['velto.dbKey']` (legacy device key, `crypto.ts:12`) still protects the reference-data cache only; documents are UK-only (accepted risk, `crypto.ts:5-10`).
- Evidence (screenshots without secrets, `scenarios.tsv`, JSON counts) stays in the session scratchpad, not committed.
