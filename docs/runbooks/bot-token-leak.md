# Telegram bot token (or webhook secret) leaked
- **Detection:** token seen in a repo/log/chat/screenshot; gitleaks (CI) finding; unexpected bot activity.
- **Severity:** SEV1 (anyone can impersonate the bot / forge initData validation if the token is known).
- **Triage:** 1) Revoke at once in BotFather (`/revoke`) - new token. 2) Update `TELEGRAM_BOT_TOKEN` in the production `.env.production.local`; set a NEW `TELEGRAM_WEBHOOK_SECRET` and re-run Telegram `setWebhook` with the new `secret_token`. 3) Restart: `pm2 restart velto-api --update-env`. 4) If it was committed: rotate first, then remove from history only as a follow-up (history is already compromised); check `.gitleaks.toml` has no allowlist for it.
- **Data safety:** Old initData signed with the old token stops validating (agents re-open the Mini App; offline queues are unaffected). Review `AuditLog`/auth logs for logins in the exposure window; revoke sessions of suspicious users. Never paste the new token in tickets or logs.
- **Owner:** Security owner / Tech Lead.
- **Verification:** old token returns 401 at Telegram; test Mini App login works; webhook with the old secret is rejected, new one accepted; gitleaks clean.
- **Comms:** Tell customers agents may need to reopen the Mini App; if unauthorised access is found, follow the incident/notification process owned by the Security owner + Legal.
