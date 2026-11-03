# ADR-071: opt-in Offline Unlock (miniapp)

Status: implemented on `feat/approved-decisions`, not committed. Relaxes ADR-068 (see "ADR-068 note").

## Causes
- A (shell): `public/sw.js` had runtime caching only; unvisited routes/chunks failed on an offline cold start. Fix: `sw-logic.js` `coreRouteUrls`/`extractAssetUrls`, `sw.js` message `WARM_SHELL` (home, order/new, payment/new, queue, route, settings + referenced chunks), sent by `ServiceWorkerRegister` once authenticated. Cache `v2`.
- B (auth): `resumeSession` `{kind:'offline'}` was mapped to `unauthenticated`, so the fallback showed "session expired". UK was reachable only through the network KEK (`vault.ts`, `offline-kek.ts`).

## Model
- Statuses `offline-locked` (tokens kept, server unreachable: unlock form if an entry exists, else an honest "no network, offline access not enabled") and `offline-local` (unlocked).
- Dexie v7 `offlineUnlock` `[userId+companyId]`: `fmt:'pw1'`, `wrappedUK` (AES-KW), 16 B random `salt`, `params{m,t,p,v:19}`, `kekVersion`, `enrolledAt`, `lastOnlineAt`, `failCount`, `nextAttemptAt`, `profile` (minimal AuthenticatedUser sealed under the UK, so the shell renders offline). Never the passphrase, derived key or raw UK. No migration of existing rows.
- Enroll only online, vault ready, fresh KEK fetched: UK unwrapped extractable once, PWK = Argon2id (hash-wasm 4.12.0, exact pin, WASM, same-origin Worker, `secret` = `companyId|userId` binds the wrap to its owner), non-extractable AES-KW, `wrapKey(UK)`. Buffers zeroed.
- Unlock adopts the UK in memory (`adoptUnlockedKey`), session = entry owner, LOCAL MODE: `apiFetch` and token refresh throw before any fetch, sync paused. Orders/visits/payments queue PENDING under the owner; CONFIRMED is never produced locally.
- Leaving local mode = explicit "Reconnect": fresh online `/auth/me` must equal the owner (id+companyId); mismatch locks the vault; only then sync resumes (existing token-owner guard).

## Parameters (rationale, TODO)
Target m=64 MiB, t=3, p=1; floor m=19 MiB, t=2, p=1 (OWASP minimum) when the device cannot allocate the target; params are stored per entry. TODO: benchmark on the pilot low-end Android WebViews (unlock latency target < 2 s, no OOM) and adjust.
Passphrase: >=12 chars, not all digits, no 3+ repeated/sequential run, no first/last name, no phone (phone is not in `/auth/me`; checked when supplied), small denylist, confirm field.
Wrong passphrase: AES-KW integrity failure; backoff 2 s x 2^(n-1) capped 15 min; entry deleted at 10 failures. TTL: refuse if now > lastOnlineAt+72 h or now < lastOnlineAt (clock rollback); `lastOnlineAt` advances on each online auth.

## Threats
- Copy of IndexedDB: offline guessing is limited ONLY by Argon2id cost + passphrase strength (the attempt counter is local and can be bypassed on a copy). Hence a long passphrase, opt-in, 72 h TTL.
- XSS / compromised browser / rooted device with live memory: out of scope (UK sits in memory while unlocked).
- B opening A's entry: lookup by token owner; copied record fails (owner-bound KDF secret). Cross-tab owner change ends local mode and locks the UK.
- CSP: `script-src` gains `'wasm-unsafe-eval'` only (no `unsafe-eval`).

## Lifecycle
Expiry / network failure keep the entry. Explicit logout deletes the owner's entry. Revoke (`handleSessionRevoked`), `emergencyWipe`/`wipeVaultKeys`, KEK 410 (vault retired) delete it at the next online contact. KEK rotation keeps it (independent wrap). Fail-closed: no IndexedDB / crypto.subtle / WebAssembly / Worker -> settings card hidden, online flow unchanged.

## ADR-068 note
ADR-068 said vault rows are readable only after a KEK fetch. With Offline Unlock enabled they are also readable with the passphrase (explicit, opt-in per user). Without an entry nothing changes.

## Addendum: offline client-side navigation (SW RSC cache)
- The SW warms (`WARM_SHELL`) HTML **and** the full-tree RSC payload of every core route (home, order/new, payment/new, queue, route, settings, report, visit). Offline, `?_rsc=` navigation and Link-prefetch requests of the same exact path are answered from that cache (key ignores `_rsc`, never shared between paths; live partial responses and `Next-Router-Segment-Prefetch` are never cached/served). Without this Next falls back to a document load, which drops the memory-only UK.
- Invariant: core routes must stay static/client-only (no `cookies()`/`headers()`/auth in their server components): the shell/RSC cache is not wiped on logout/revoke, so it must hold no user-specific data. Redirected responses are never cached.
- A served full-tree payload hands the intl provider new props. Provider-level effects (auth bootstrap, vault bring-up, sync cycle) therefore must not depend on `useTranslations` function identities (read through refs), and the cache wipe that drops the unused device key (`dropDeviceKeyIfUnused`) runs only on a first, online bring-up (never offline, in local mode, or when the UK was already in memory). Network loss must never wipe the reference cache or the queue.
