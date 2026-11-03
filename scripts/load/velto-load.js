// k6 load profile for Velto API (TZ §12.1/§12.5, ADR-053). LOCAL ONLY, not an SLA.
// Target: apps/api on velto_load (see start-api.sh). No secrets in this file: the shared
// password of the synthetic load users comes from env LOAD_PASSWORD.
//
//   MODE=mixed VUS=50 DURATION=90s  → read + write + agent(sync) + cashier VUs side by side
//   MODE=read|write|sync  VUS=n      → single profile (for isolating a scenario)
// Pacing: every VU has its OWN userId (API throttler is per userId, 120/min, hardcoded) and
// sleeps so that no VU exceeds ~100 req/min; the 429 counter proves/dispels throttle noise.
import http from 'k6/http';
import { sleep, check, fail } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

const BASE = __ENV.BASE_URL || 'http://host.docker.internal:3011';
const PASSWORD = __ENV.LOAD_PASSWORD;
const FX = JSON.parse(open(__ENV.FIXTURES || '/work/fixtures.json'));
const VUS = Number(__ENV.VUS || 50);
const DURATION = __ENV.DURATION || '90s';
const REPORTS = (__ENV.REPORTS || '1') === '1';
const MODE = __ENV.MODE || 'mixed';

export const c5xx = new Counter('r_5xx');
export const c503 = new Counter('r_503'); // SERVICE_BUSY (retryable), NOT counted in r_5xx
export const cConn = new Counter('r_conn_err');
export const c429 = new Counter('r_429');
export const c4xx = new Counter('r_4xx_other');
export const cOk = new Counter('r_ok');
export const tSync = new Trend('sync_push20_ms', true);
export const tDash = new Trend('dash_dur', true);

// Allocation per tenant: ~10-20% write chains, ~20% agents (sync), 1 cashier, rest reads.
// Multi-tenant: fixtures.json may be {tenants:[fx,...]} (prepare-multi-load-data.sh); total VUS are spread
// evenly across the first TENANTS tenants (each ~VUS/N), every VU belongs to exactly one tenant.
const TENANT_FX = (FX.tenants || [FX]).slice(0, Number(__ENV.TENANTS || 99));
const NT = TENANT_FX.length;
const T = TENANT_FX.map((fx, i) => {
  const vus = Math.floor(VUS / NT) + (i < VUS % NT ? 1 : 0);
  const nWrite = MODE === 'read' || MODE === 'sync' ? 0 : Math.max(1, Math.round(vus * (vus >= 100 ? 0.15 : 0.2)));
  const nAgent = MODE === 'read' || MODE === 'write' ? 0 : Math.max(1, Math.min(30, Math.round(vus * (MODE === 'syncheavy' ? 0.5 : 0.2)))); // syncheavy = (C) sync-push dominant, capped by agent users
  const nCash = MODE === 'mixed' || MODE === 'syncheavy' ? 1 : 0;
  const nRead = MODE === 'write' || MODE === 'sync' ? 0 : Math.max(1, vus - nWrite - nAgent - nCash);
  if (nWrite + nRead > fx.owners.length) fail(`tenant ${i}: not enough owner users (${fx.owners.length}) for ${nWrite + nRead} VUs`);
  if (nAgent > fx.agents.length) fail(`tenant ${i}: not enough agent users`);
  return { fx, nWrite, nAgent, nCash, nRead, total: nWrite + nAgent + nCash + nRead };
});
T.reduce((off, t) => { t.offset = off; return off + t.total; }, 0);

// One scenario, VU role chosen by VU id (k6 interleaves VU ids across scenarios, so per-scenario
// index maths is unsafe): VU ids are split into contiguous per-tenant blocks; inside a block ids
// [0,nAgent) agent, then cashier, then write, then read. Each VU keeps its own user => one userId per VU.
const scenarios = { load: { executor: 'constant-vus', vus: T.reduce((a, t) => a + t.total, 0), duration: DURATION, exec: 'dispatch' } };

export function dispatch(tokens) {
  const gid = __VU - 1;
  const ti = T.findIndex((t) => gid >= t.offset && gid < t.offset + t.total);
  const t = T[ti], id = gid - t.offset, tk = tokens[ti];
  if (id < t.nAgent) return agentFlow(tk, id, t);
  if (id < t.nAgent + t.nCash) return cashierFlow(tk, id - t.nAgent);
  if (id < t.nAgent + t.nCash + t.nWrite) return writeFlow(tk, id - t.nAgent - t.nCash, t);
  return readFlow(tk, id - t.nAgent - t.nCash - t.nWrite, t);
}

export const options = {
  scenarios,
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  thresholds: {
    'http_req_duration{kind:read}': VUS <= 50 ? ['p(95)<300'] : [],
    'http_req_duration{kind:write}': VUS <= 50 ? ['p(95)<700'] : [],
    r_5xx: VUS >= 100 ? ['count==0'] : [],
  },
};

const JSON_H = { 'Content-Type': 'application/json' };

function login(phone) {
  const r = http.post(`${BASE}/auth/login`, JSON.stringify({ phone, password: PASSWORD }), { headers: JSON_H, tags: { kind: 'setup' } });
  if (r.status !== 200 && r.status !== 201) fail(`login failed ${r.status} for ${phone.slice(0, 8)}***`);
  return r.json('accessToken');
}

export function setup() {
  if (!PASSWORD) fail('LOAD_PASSWORD env is required');
  return T.map((t) => {
    const tokens = { owners: [], agents: [], cashiers: [] };
    const need = { owners: t.nWrite + t.nRead, agents: t.nAgent, cashiers: t.nCash };
    for (const k of Object.keys(need)) for (let i = 0; i < need[k]; i++) tokens[k].push(login(t.fx[k][i]));
    for (const c of tokens.cashiers) { // shift for handover accept; "already open" is fine
      http.post(`${BASE}/cash-sessions/open`, JSON.stringify({ openAmount: 0 }), { headers: { ...JSON_H, Authorization: `Bearer ${c}` }, tags: { kind: 'setup' } });
    }
    return tokens;
  });
}

function call(method, path, token, kind, name, body, extra = {}) {
  const headers = { Authorization: `Bearer ${token}`, ...(body ? JSON_H : {}), ...(extra.idem ? { 'Idempotency-Key': uuidv4() } : {}) };
  const res = http.request(method, `${BASE}${path}`, body ? JSON.stringify(body) : null, { headers, tags: { kind, name }, timeout: '60s' });
  if (res.status === 0) { cConn.add(1, { kind, name }); if (__ENV.LOG_5XX) console.error(`conn ${method} ${path} ${res.error}`); }
  else if (res.status === 503) { c503.add(1, { kind, name }); if (__ENV.LOG_5XX) console.error(`503 ${method} ${path} ${String(res.body).slice(0, 120)}`); }
  else if (res.status >= 500) { c5xx.add(1, { kind, name }); if (__ENV.LOG_5XX) console.error(`5xx ${res.status} ${method} ${path} ${String(res.body).slice(0, 200)}`); }
  else if (res.status === 429) c429.add(1, { kind, name });
  else if (res.status >= 400) { c4xx.add(1, { kind, name }); if (__ENV.LOG_4XX) console.error(`4xx ${res.status} ${method} ${path} ${String(res.body).slice(0, 200)}`); }
  else cOk.add(1, { kind, name });
  return res;
}

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const orderBody = (FXT, qtyMax = 3) => ({
  customerId: pick(FXT.customers), warehouseId: FXT.warehouseId, clientId: uuidv4(),
  lines: Array.from({ length: 1 + Math.floor(Math.random() * 5) }, () => {
    const p = pick(FXT.products); return { productId: p.p, packagingId: p.k, qty: 1 + Math.floor(Math.random() * qtyMax) };
  }),
});

function readFlow(tokens, idx, T0) {
  const FX = T0.fx;
  const t = tokens.owners[T0.nWrite + idx]; // owners[0..nWrite) belong to write VUs
  const c = pick(FX.customers);
  const reqs = [
    ['products', `/products?pageSize=50&page=${1 + Math.floor(Math.random() * 20)}`], ['customers', `/customers?pageSize=50&page=${1 + Math.floor(Math.random() * 20)}`], ['price-lists', `/price-lists`],
    ['stock', `/stock?warehouseId=${FX.warehouseId}&pageSize=50&page=${1 + Math.floor(Math.random() * 20)}`], ['customer-detail', `/customers/${c}`],
    ['orders', `/orders?pageSize=50&page=${1 + Math.floor(Math.random() * 20)}`], ['customer-balance', `/customers/${c}/balance`],
  ];
  const [name, path] = pick(reqs);
  call('GET', path, t, 'read', name);
  sleep(0.4 + Math.random() * 0.4);
  const r = REPORTS ? Math.random() : 1; // REPORTS=0 isolates list/detail reads from heavy report queries
  if (r < 0.10) { const d = call('GET', '/reports/dashboard', t, 'report', 'dashboard'); if (d.status === 200) tDash.add(d.timings.duration, { kind: 'report', name: d.json('cached') ? 'dashboard-hit' : 'dashboard-miss' }); }
  else if (r < 0.18) call('GET', '/reports/sales', t, 'report', 'sales');
  else if (r < 0.24) call('GET', '/reports/overview', t, 'report', 'overview');
  sleep(0.4 + Math.random() * 0.4);
}

function writeFlow(tokens, idx, T0) {
  const t = tokens.owners[idx];
  const cr = call('POST', '/orders', t, 'write', 'order-create', orderBody(T0.fx));
  if (cr.status === 201) {
    const id = cr.json('id');
    const cf = call('POST', `/orders/${id}/confirm`, t, 'write', 'order-confirm', null, { idem: true });
    if (cf.status < 300) {
      call('POST', `/orders/${id}/deliver`, t, 'write', 'order-deliver', {}, { idem: true });
    }
  }
  sleep(2 + Math.random() * 2);
}

function agentFlow(tokens, idx, T0) {
  const FX = T0.fx;
  const t = tokens.agents[idx];
  const docs = [];
  for (let i = 0; i < 20; i++) {
    if (i % 7 === 6) docs.push({ type: 'payment', clientId: uuidv4(), payload: { customerId: pick(FX.customers), amount: 10000 + i * 1000, method: 'CASH', clientId: undefined } });
    else docs.push({ type: 'order', clientId: uuidv4(), payload: orderBody(FX, 2) });
  }
  for (const d of docs) if (d.type === 'payment') d.payload.clientId = d.clientId; else d.payload.clientId = d.clientId;
  const r = call('POST', '/sync/push', t, 'sync', 'sync-push-20', { documents: docs });
  tSync.add(r.timings.duration);
  if (r.status === 201 || r.status === 200) {
    const res = r.json('results') || [];
    check(r, { 'push: all 20 results ACCEPTED/DUPLICATE': () => res.length === 20 && res.every((x) => x.status === 'ACCEPTED' || x.status === 'DUPLICATE') });
  }
  sleep(3);
  const p1 = call('GET', '/sync/pull?limit=500', t, 'sync', 'sync-pull-full-page'); // first page of a full snapshot
  const cur = p1.status === 200 ? p1.json('cursor') : null;
  sleep(3);
  if (cur) call('GET', `/sync/pull?limit=500&cursor=${encodeURIComponent(cur)}`, t, 'sync', 'sync-pull-next'); // incremental/next page
  sleep(3);
}

function cashierFlow(tokens, idx) {
  const t = tokens.cashiers[idx];
  const l = call('GET', '/payments?status=PENDING_HANDOVER&pageSize=20', t, 'read', 'payments-pending');
  const items = l.status === 200 ? (l.json('items') || l.json('data') || []) : [];
  for (const p of items.slice(0, 3)) call('POST', `/payments/${p.id}/handover/accept`, t, 'write', 'handover-accept', null, { idem: true });
  sleep(2);
}
