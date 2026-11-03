# Telegram login failures (Mini App)
- **Detection:** agents cannot sign in via Mini App; spike of 401/429 on `POST /auth/telegram`; `pm2 logs velto-api` auth failures. Alert: (planned).
- **Severity:** SEV2 (field agents blocked) - but offline already-logged-in work continues.
- **Triage:** 1) Is `TELEGRAM_BOT_TOKEN` set and the correct bot (initData HMAC uses it; empty = fail closed)? 2) initData too old: `TELEGRAM_INITDATA_MAX_AGE_SECONDS` (600) or replay limit `TELEGRAM_INITDATA_MAX_USES` (20) hit - ask the user to reopen the Mini App to get fresh initData. 3) Clock skew on the VPS (NTP). 4) Rate limiter (`LoginRateLimiterService`) locking out - wait window. 5) Webhook rejects: `TELEGRAM_WEBHOOK_SECRET` must equal the setWebhook `secret_token`.
- **Data safety:** Do not weaken HMAC/age/replay checks to "get people in". Fallback is phone+password `POST /auth/login`. No tokens or initData in tickets/logs.
- **Owner:** Tech Lead (auth) + Ops owner.
- **Verification:** a test account logs in via `POST /auth/telegram`, `GET /auth/me` returns the right tenant/roles; failure rate returns to baseline.
- **Comms:** Tell agents to use phone+password or reopen the Mini App; give ETA.
