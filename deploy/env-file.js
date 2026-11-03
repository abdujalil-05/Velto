'use strict';
// ONE env-file rule shared by ecosystem.config.js (PM2 env) and deploy.sh (migrate/build env).
// Before this module the two disagreed: PM2 kept `KEY=value # comment` verbatim (comment inside the value) while
// deploy.sh `source`d the file and silently dropped the comment (and expanded $vars / backticks).
//
// Rule (no shell semantics at all):
//   - blank lines and lines whose first non-space char is '#' are ignored
//   - `KEY=VALUE`, KEY = [A-Za-z0-9_]+, value = everything after the first '=' with surrounding whitespace trimmed
//   - one pair of matching surrounding quotes ('...' or "...") is stripped; the content is taken literally
//   - NO inline comments: an UNQUOTED value containing whitespace followed by '#' is an ERROR (ambiguous), not silently kept/cut
//   - any other non-blank line (e.g. `export KEY=v`, no '=') is an ERROR
// Errors name the line number and key only, never the value (values are secrets).
const fs = require('node:fs');

function parseEnv(text, label) {
  const out = {};
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (/^\s*(#.*)?$/.test(line)) continue;
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) throw new Error(`${label}:${i + 1}: not a KEY=VALUE line (export/shell syntax is not supported)`);
    const [, key, raw] = m;
    const q = /^(['"])([\s\S]*)\1$/.exec(raw);
    if (q) { out[key] = q[2]; continue; }
    if (/\s#/.test(raw)) throw new Error(`${label}:${i + 1}: ${key}: inline comment after an unquoted value is not allowed (move it to its own line or quote the value)`);
    out[key] = raw;
  }
  return out;
}

function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  return parseEnv(fs.readFileSync(file, 'utf8'), file);
}

// bash side: `eval "$(node env-file.js export <file> [KEY ...])"` prints `export KEY='escaped'` (only the listed keys if any).
function shQuote(v) { return `'${String(v).replace(/'/g, `'\\''`)}'`; }
if (require.main === module) {
  const [, , cmd, file, ...keys] = process.argv;
  if (cmd !== 'export' || !file) { process.stderr.write('usage: env-file.js export <file> [KEY ...]\n'); process.exit(2); }
  try {
    if (!fs.existsSync(file)) throw new Error(`${file}: missing`);
    const env = readEnvFile(file);
    for (const k of Object.keys(env)) if (!keys.length || keys.includes(k)) process.stdout.write(`export ${k}=${shQuote(env[k])}\n`);
  } catch (e) { process.stderr.write(`env-file: ${e.message}\n`); process.exit(1); }
}
module.exports = { parseEnv, readEnvFile };
