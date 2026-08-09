// pm2 process definitions for the auto-message.uz/velto deployment.
//
//   pm2 start deploy/ecosystem.config.js
//   pm2 save                 # restore on reboot (pm2 startup already installed)
//   pm2 restart velto-api    # after a rebuild
//
// Ports live in the 31xx range because 3000/3001 are taken by MarketCo on this
// host. nginx routes to them via /etc/nginx/snippets/velto.conf:
//
//   https://auto-message.uz/velto/      → velto-web      (127.0.0.1:3100)
//   https://auto-message.uz/velto/api/  → velto-api      (127.0.0.1:3101)
//   https://auto-message.uz/velto/app/  → velto-miniapp  (127.0.0.1:3102)

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

// The repo-root .env has to be in the *process environment*, not just loaded
// later by Nest's ConfigModule: packages/database/src/client.ts constructs
// systemPrisma from process.env.DATABASE_SYSTEM_URL at import time, which
// happens while app.module.ts is still being required — before ConfigModule
// ever runs. pm2 has no env_file option, and `dotenv` isn't resolvable from
// the workspace root under pnpm, so parse it here.
function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i.exec(line);
    if (!match) continue; // comment or blank
    out[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/s, '$2');
  }
  return out;
}

// `.env` is the developer's local file and stays pointed at the dev database;
// `.env.production.local` (gitignored, chmod 600) holds this deployment's real
// credentials and wins on every key it defines. Layering rather than replacing
// means a var added to `.env.example`/`.env` later still has a value here
// instead of failing env.schema.ts validation at boot.
const env = {
  ...readEnvFile(path.join(root, '.env')),
  ...readEnvFile(path.join(root, '.env.production.local')),
  NODE_ENV: 'production',
};

// The two Next.js processes get NONE of the above. They need nothing from it:
// every value they read is a NEXT_PUBLIC_* one, inlined into the bundle at
// build time from apps/{web,miniapp}/.env.production.local, and Next loads
// that file itself on `next start`. Handing them the API's environment would
// put DATABASE_SYSTEM_URL — the BYPASSRLS role that defeats every RLS policy —
// plus JWT_ACCESS_SECRET, S3_SECRET_KEY and the bot token one SSR-side file-read
// or SSRF bug away from an attacker, for no benefit.
const nextEnv = { NODE_ENV: 'production' };

module.exports = {
  apps: [
    {
      name: 'velto-api',
      cwd: path.join(root, 'apps/api'),
      script: 'dist/main.js',
      env,
      // BullMQ consumers run in-process (see CLAUDE.md) — a single instance
      // keeps job handling single-consumer, as the MVP assumes.
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '600M',
    },
    {
      // node_modules/.bin/next is a shell wrapper; pm2 would hand it to node
      // and choke on the shebang. Point at the real JS entry instead.
      name: 'velto-web',
      cwd: path.join(root, 'apps/web'),
      script: 'node_modules/next/dist/bin/next',
      // ⚠️ Do NOT add `-H 127.0.0.1` here, however much it looks like the right
      // hardening. Passing -H makes Next treat that address as the canonical
      // origin and emit ABSOLUTE redirects to it: next-intl's locale redirect
      // at the app root came back as `Location: https://localhost:3102/velto/uz`
      // instead of the relative `/velto/uz`, i.e. a dead link for every visitor
      // (verified on this host). Without -H, Next emits a relative Location and
      // the proxy works. The plaintext ports are kept off the internet by ufw
      // instead — 3100/3102 are not in its allow list. (apps/api has no such
      // problem: Nest never builds URLs from the bind address, so it does bind
      // 127.0.0.1 via API_HOST.)
      args: 'start -p 3100',
      env: nextEnv,
      max_memory_restart: '600M',
    },
    {
      name: 'velto-miniapp',
      cwd: path.join(root, 'apps/miniapp'),
      script: 'node_modules/next/dist/bin/next',
      // Same as velto-web: no -H, or Next emits absolute redirects to it.
      args: 'start -p 3102',
      env: nextEnv,
      max_memory_restart: '600M',
    },
  ],
};
