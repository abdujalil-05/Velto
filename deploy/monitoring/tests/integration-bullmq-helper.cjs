'use strict';
// Helper for deploy/monitoring/tests/integration-bullmq.test.sh. Uses the REAL bullmq/ioredis from apps/api.
// Synthetic data only. Every key it touches lives under the throwaway prefix velto-montest-<pid> (cleanup refuses anything else).
const { createRequire } = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const apiRequire = createRequire(path.resolve(__dirname, '../../../apps/api/package.json'));
const { Queue, Worker } = apiRequire('bullmq');
const IORedis = apiRequire('ioredis');

const MARKER = 'SECRET_PAYLOAD_MARKER';
const host = process.env.H_REDIS_HOST || '127.0.0.1';
const port = Number(process.env.H_REDIS_PORT || 6380);
const SAFE_PREFIX = /^velto-montest-[0-9]+$/;
const mkConn = () => new IORedis({ host, port, maxRetriesPerRequest: null });
const [cmd, ...a] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function needPrefix(p) {
  if (!SAFE_PREFIX.test(p || '')) { console.error(`refusing prefix ${p}`); process.exit(2); }
  return p;
}

async function main() {
  switch (cmd) {
    case 'meta': { // create the queue (BullMQ writes <prefix>:<q>:meta)
      const [q, prefix] = a; const queue = new Queue(q, { connection: mkConn(), prefix: needPrefix(prefix) });
      await queue.waitUntilReady(); await queue.close(); break;
    }
    case 'add': { // add <queue> <prefix> <jobId> [optsJson]
      const [q, prefix, jobId, opts] = a; const queue = new Queue(q, { connection: mkConn(), prefix: needPrefix(prefix) });
      await queue.add('t', { secret: MARKER, note: `payload ${MARKER}` }, { jobId, ...(opts ? JSON.parse(opts) : {}) });
      await queue.close(); break;
    }
    case 'promote': { // promote <queue> <prefix> <jobId>: real BullMQ delayed -> wait (keeps attemptsMade/processedOn like a backed-off retry)
      const [q, prefix, jobId] = a; const queue = new Queue(q, { connection: mkConn(), prefix: needPrefix(prefix) });
      const job = await queue.getJob(jobId); await job.promote(); await queue.close(); break;
    }
    case 'pause': {
      const [q, prefix] = a; const queue = new Queue(q, { connection: mkConn(), prefix: needPrefix(prefix) });
      await queue.pause(); await queue.close(); break;
    }
    case 'worker': { // worker <queue> <prefix> <ok|hang|fail>; env STALL_MS, MAX_STALLED, CONCURRENCY
      const [q, prefix, mode] = a; needPrefix(prefix);
      const o = { connection: mkConn(), prefix, concurrency: Number(process.env.CONCURRENCY || 1), maxStalledCount: Number(process.env.MAX_STALLED || 1) };
      if (process.env.STALL_MS) { o.lockDuration = Number(process.env.STALL_MS); o.stalledInterval = Number(process.env.STALL_MS); }
      const w = new Worker(q, async () => {
        console.log('started');
        if (mode === 'hang') await new Promise(() => {});
        if (mode === 'fail') throw new Error(`boom ${MARKER}`);
        return { done: true, secret: MARKER };
      }, o);
      w.on('error', () => {});
      await w.waitUntilReady(); console.log('ready');
      process.on('SIGTERM', async () => { await w.close(true).catch(() => {}); process.exit(0); });
      setInterval(() => {}, 1 << 30); break;
    }
    case 'age': { // age <queue> <prefix> <jobId> <field> <minutesAgo>: rewind a job-hash timestamp field (test manipulation of a real job)
      const [q, prefix, jobId, field, mins] = a; const c = mkConn();
      await c.hset(`${needPrefix(prefix)}:${q}:${jobId}`, field, String(Date.now() - Number(mins) * 60000)); c.disconnect(); break;
    }
    case 'delayed-age': { // delayed-age <queue> <prefix> <jobId> <minutesAgo>: score = (now-min)*4096 as BullMQ encodes it
      const [q, prefix, jobId, mins] = a; const c = mkConn();
      const score = (BigInt(Date.now() - Number(mins) * 60000) * 4096n).toString();
      await c.zadd(`${needPrefix(prefix)}:${q}:delayed`, 'XX', score, jobId); c.disconnect(); break;
    }
    case 'cleanup': { // delete ONLY keys under the throwaway prefix
      const prefix = needPrefix(a[0]); const c = mkConn(); let n = 0;
      await new Promise((res, rej) => {
        const s = c.scanStream({ match: `${prefix}:*`, count: 200 });
        s.on('data', async (keys) => { s.pause(); if (keys.length) { n += await c.del(...keys); } s.resume(); });
        s.on('end', res); s.on('error', rej);
      });
      console.log(`deleted ${n}`); c.disconnect(); break;
    }
    case 'sink': { // sink <alertLog> <portFile>: fake webhook + fake API health endpoint on 127.0.0.1
      const [log, portFile] = a;
      const srv = http.createServer((req, res) => {
        if (req.method === 'GET' && req.url.startsWith('/health')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"status":"up","checks":{"db":"up","redis":"up","storage":"up"}}'); return;
        }
        let body = ''; req.on('data', (d) => { body += d; });
        req.on('end', () => {
          const text = new URLSearchParams(body).get('text') || '';
          fs.appendFileSync(log, `@@@ ${req.method} ${req.url}\n${text}\n`);
          res.writeHead(200); res.end('ok');
        });
      });
      srv.listen(0, '127.0.0.1', () => fs.writeFileSync(portFile, String(srv.address().port)));
      setInterval(() => {}, 1 << 30);
      process.on('SIGTERM', () => process.exit(0)); break;
    }
    default: console.error(`unknown cmd ${cmd}`); process.exit(2);
  }
  if (cmd !== 'worker' && cmd !== 'sink') process.exit(0);
}
main().catch((e) => { console.error(String(e && e.message)); process.exit(1); });
void sleep;
