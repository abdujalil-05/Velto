// Aggregates a k6 `--out json` file into per-kind/per-endpoint p50/p95/p99, RPS and error counts.
// Usage: node summarize.js results/raw.json  (stdout: markdown tables). No deps.
const fs = require('fs');
const rl = require('readline').createInterface({ input: fs.createReadStream(process.argv[2]) });
const dur = {}; const cnt = {}; let t0 = Infinity, t1 = 0;
const add = (m, k, v) => ((m[k] ||= []).push(v));
rl.on('line', (l) => {
  if (!l.includes('"type":"Point"')) return;
  const o = JSON.parse(l); const { metric, data } = o; const tg = data.tags || {};
  const ts = Date.parse(data.time);
  if (metric === 'http_req_duration' && tg.kind && tg.kind !== 'setup') {
    add(dur, `${tg.kind}|${tg.name}`, data.value); add(dur, `${tg.kind}|*`, data.value); add(dur, '*|*', data.value);
    t0 = Math.min(t0, ts); t1 = Math.max(t1, ts);
  } else if (metric.startsWith('r_') && tg.kind) {
    const k = `${tg.kind}|${tg.name}`; (cnt[k] ||= {})[metric] = (cnt[k][metric] || 0) + data.value;
    (cnt['*|*'] ||= {})[metric] = (cnt['*|*'][metric] || 0) + data.value;
    (cnt[`${tg.kind}|*`] ||= {})[metric] = (cnt[`${tg.kind}|*`][metric] || 0) + data.value;
  }
});
const q = (a, p) => a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
rl.on('close', () => {
  const secs = Math.max(1, (t1 - t0) / 1000);
  console.log(`window ${secs.toFixed(0)}s\n\n| kind|endpoint | n | rps | p50 ms | p95 ms | p99 ms | max ms | 5xx | conn_err | 429 | other 4xx |\n|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const k of Object.keys(dur).sort()) {
    const a = dur[k].sort((x, y) => x - y); const c = cnt[k] || {};
    console.log(`| ${k} | ${a.length} | ${(a.length / secs).toFixed(1)} | ${q(a, 50).toFixed(0)} | ${q(a, 95).toFixed(0)} | ${q(a, 99).toFixed(0)} | ${a[a.length - 1].toFixed(0)} | ${c.r_5xx || 0} | ${c.r_conn_err || 0} | ${c.r_429 || 0} | ${c.r_4xx_other || 0} |`);
  }
});
