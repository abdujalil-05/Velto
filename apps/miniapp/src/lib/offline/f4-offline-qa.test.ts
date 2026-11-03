import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTokens, getAccessToken, setTokens } from '@/lib/auth/tokens';
import { onUnauthorized } from '@/lib/api/client';
import Dexie from 'dexie';
import { encryptValue } from './crypto';
import { db } from './db';
import { EncryptedStore } from './encrypted-store';
import { QueueQuotaError, queueCodec, queueRepository } from './queue';
import { setOfflineSession } from './session';
import { lockVault } from './vault';
import { readyVault } from './vault-test-helper';
import { resetPreparedSession } from './session-bootstrap';
import { getLastStorageStatus, publishStorageStatus } from './storage-budget';
import { resetPushBatchLimit, runPush } from './sync-engine-core';

/**
 * F4.4 offline QA (TZ 8.5 / 16.2): the REAL runPush -> pushSync -> apiFetch -> fetch path against a
 * stateful in-memory fake of POST /sync/push (idempotent by clientId, like the API), on fake-indexeddb.
 */
const A = { userId: 'uA', companyId: 'c1' };
const B = { userId: 'uB', companyId: 'c1' };
/** Owner-claim JWT-shaped token (the sync engine refuses tokens whose sub/companyId differ from the session owner). */
const tok = (label: string, sub = 'uA') => `e30.${btoa(JSON.stringify({ sub, companyId: 'c1', label })).replace(/=/g, '')}.sig`;
const STALE = tok('stale');
const FRESH = tok('fresh');
const RELOGIN = tok('relogin');
const asUser = async (u: typeof A) => {
  setOfflineSession(u);
  await readyVault(u);
  resetPreparedSession();
};

interface Doc { type: string; clientId: string; payload: Record<string, unknown> }
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Fake server: dedupes by clientId, records every request, can be told to fail in specific ways. */
class FakeServer {
  created = new Map<string, string>(); // clientId -> serverId
  requests: string[][] = []; // clientIds per /sync/push request, in arrival order
  payloads = new Map<string, Record<string, unknown>>();
  online = true;
  loseResponses = 0; // process the request, then drop the response (lost ACK)
  dieOnRequestNo: number | null = null; // 1-based request number that never reaches the server
  conflictFor = new Set<string>();
  unauthorizedOnce = false;
  refreshOk = true;
  refreshCalls = 0;
  authHeaders: (string | null)[] = [];
  private n = 0;

  fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    if (!this.online) throw new TypeError('Failed to fetch');
    if (u.endsWith('/auth/refresh')) {
      this.refreshCalls += 1;
      return this.refreshOk ? json(201, { accessToken: FRESH, refreshToken: 'fresh-refresh' }) : json(401, { code: 'UNAUTHORIZED', message: { uz: '', ru: '', en: '' } });
    }
    if (!u.endsWith('/sync/push')) throw new Error(`unexpected ${u}`);
    this.authHeaders.push(new Headers(init?.headers).get('Authorization'));
    if (this.unauthorizedOnce) {
      this.unauthorizedOnce = false;
      return json(401, { code: 'UNAUTHORIZED', message: { uz: '', ru: '', en: '' } });
    }
    this.n += 1;
    if (this.dieOnRequestNo === this.n) throw new TypeError('Failed to fetch');
    const docs = (JSON.parse(String(init?.body)) as { documents: Doc[] }).documents;
    this.requests.push(docs.map((d) => d.clientId));
    const results = docs.map((d) => {
      if (this.conflictFor.has(d.clientId)) {
        return { clientId: d.clientId, status: 'CONFLICT', error: { code: 'PRICE_CHANGED', message: 'narx', details: { lines: [{ lineIndex: 0, productId: 'p', packagingId: 'k', expectedUnitPrice: '9000.00', serverUnitPrice: '10000.00' }], expectedTotal: '10080.00', serverTotal: '11200.00' } } };
      }
      this.payloads.set(d.clientId, d.payload);
      const existing = this.created.get(d.clientId);
      if (existing) return { clientId: d.clientId, status: 'DUPLICATE', id: existing };
      const id = `srv-${this.created.size + 1}`;
      this.created.set(d.clientId, id);
      return { clientId: d.clientId, status: 'ACCEPTED', id };
    });
    if (this.loseResponses > 0) {
      this.loseResponses -= 1;
      throw new TypeError('Failed to fetch'); // server committed; client never saw the ACK
    }
    return json(201, { results });
  };
  sent = () => this.requests.flat();
}

let server: FakeServer;
const rawStore = () => new EncryptedStore<Record<string, unknown>, string>(db.queue as never, ['clientId', 'type', 'status', 'createdAt', 'userId', 'companyId']);
const vaultStore = () => new EncryptedStore<Record<string, unknown>, string>(db.queue as never, ['clientId', 'type', 'status', 'createdAt', 'userId', 'companyId', 'seq'], ['seq'], queueCodec as never);
const entries = () => queueRepository.listAllOwners();
async function makeAllDue() {
  const s = vaultStore();
  for (const e of await entries()) await s.put({ ...(await s.get(e.clientId))!, nextAttemptAt: undefined });
}
const orderPayload = (i: number) => ({ customerId: 'cust', lines: [{ productId: 'p', packagingId: 'k', qty: 1, expectedUnitPrice: '10000.00' }], note: `n${i}` });
/** Human-paced enqueue (>=2 ms apart): createdAt is ms-resolution, ties are resolved by seq. */
async function enqueueOrders(n: number, paced = true): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(await queueRepository.enqueue('order', orderPayload(i)));
    if (paced) await new Promise((r) => setTimeout(r, 2));
  }
  return ids;
}
/** Simulates closing and reopening the app: a fresh Dexie connection, in-memory session state reset. */
async function restartApp(user = A) {
  db.close();
  await db.open();
  resetPreparedSession();
  resetPushBatchLimit();
  setOfflineSession(user);
  await readyVault(user);
}

describe('F4.4 offline QA (TZ 8.5 / 16.2)', () => {
  beforeEach(async () => {
    server = new FakeServer();
    vi.stubGlobal('fetch', server.fetch);
    resetPushBatchLimit();
    await db.queue.clear();
    await db.meta.clear();
    clearTokens();
    setTokens(STALE, 'refresh-1');
    await asUser(A);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(navigator, 'storage', { value: undefined, configurable: true });
  });

  it('8.5 airplane mode: 20 orders saved offline survive an app restart as PENDING; reconnect flushes FIFO with the same 20 unique clientIds', async () => {
    server.online = false;
    const ids = await enqueueOrders(20);
    expect(new Set(ids).size).toBe(20);
    const offlineRun = await runPush(); // tries and fails: airplane mode
    expect(offlineRun.paused).toBe('NETWORK');
    expect(server.created.size).toBe(0);

    await restartApp();
    const after = await queueRepository.listAll();
    expect(after).toHaveLength(20);
    expect(after.every((e) => e.status === 'PENDING')).toBe(true);
    expect(new Set(after.map((e) => e.clientId))).toEqual(new Set(ids));

    server.online = true;
    await makeAllDue(); // backoff elapsed
    const out = await runPush();
    expect(out).toMatchObject({ accepted: 20, paused: null });
    expect(server.sent()).toEqual(ids); // FIFO == creation order, same clientIds
    expect(new Set(server.created.keys())).toEqual(new Set(ids));
    expect((await queueRepository.listAll()).every((e) => e.status === 'SYNCED' && e.serverId)).toBe(true);
  });

  it('8.5 FIFO holds for orders enqueued in the same millisecond (monotonic seq)', async () => {
    const ids = await enqueueOrders(20, false);
    await runPush();
    expect(server.sent()).toEqual(ids);
  });

  it('8.5 same-ms enqueues keep insertion order after an app restart', async () => {
    const ids = await enqueueOrders(30, false);
    await restartApp();
    expect((await queueRepository.listPending(30)).map((e) => e.clientId)).toEqual(ids);
    expect((await queueRepository.listPushable(30)).map((e) => e.clientId)).toEqual(ids);
    const more = await enqueueOrders(3, false);
    expect((await queueRepository.listPending(33)).map((e) => e.clientId)).toEqual([...ids, ...more]);
  });

  it('8.5 Dexie v3 -> v4 upgrade keeps every queue row and backfills seq by createdAt then clientId', async () => {
    db.close();
    await Dexie.delete('velto-miniapp');
    lockVault(); // the wrapped keys died with the database; the in-memory UK must not outlive them
    const v3 = new Dexie('velto-miniapp');
    v3.version(1).stores({ products: 'id, sku, name, categoryId', packagings: 'id, productId', prices: '[priceListId+productId], productId', customers: 'id, code, name, tin', outlets: 'id, customerId', stock: '[productId+warehouseId], productId', categories: 'id, parentId', balances: 'customerId', routes: 'id, weekday', routeStops: 'id, routeId, outletId', queue: 'clientId, type, status, createdAt', meta: 'key' });
    v3.version(2).stores({ customers: 'id, code, name' });
    v3.version(3).stores({ queue: 'clientId, type, status, createdAt, userId, companyId' });
    const mk = (clientId: string, createdAt: string) => ({ clientId, type: 'order', status: 'PENDING', payload: { clientId }, createdAt, schemaVersion: 1, attemptCount: 0, userId: A.userId, companyId: A.companyId });
    const old = [mk('zz', '2026-01-01T00:00:00.000Z'), mk('bb', '2026-01-01T00:00:00.001Z'), mk('aa', '2026-01-01T00:00:00.001Z')];
    for (const e of old) {
      await v3.table('queue').put({ clientId: e.clientId, type: e.type, status: e.status, createdAt: e.createdAt, userId: e.userId, companyId: e.companyId, _enc: await encryptValue(e) });
    }
    v3.close();
    await db.open();
    resetPreparedSession();
    setOfflineSession(A);
    await readyVault(A);
    const after = await queueRepository.listPending(10);
    expect(after.map((e) => e.clientId)).toEqual(['zz', 'aa', 'bb']);
    expect(after.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(after.every((e) => e.status === 'PENDING')).toBe(true);
    const fresh = await queueRepository.enqueue('order', orderPayload(0));
    expect((await queueRepository.listPending(10)).map((e) => e.clientId)).toEqual(['zz', 'aa', 'bb', fresh]);
  });

  it('8.5 triple resend after lost ACKs: server answers DUPLICATE, queue ends SYNCED once, server holds one doc per clientId', async () => {
    const ids = await enqueueOrders(5);
    server.loseResponses = 2;
    expect((await runPush()).paused).toBe('NETWORK'); // 1st send: committed, ACK lost
    await makeAllDue();
    expect((await runPush()).paused).toBe('NETWORK'); // 2nd send: ACK lost again
    await makeAllDue();
    const third = await runPush(); // 3rd send: ACK arrives (DUPLICATE)
    expect(third.accepted).toBe(5);
    expect(server.requests).toHaveLength(3);
    expect(server.requests.every((r) => r.join() === ids.join())).toBe(true); // identical clientIds every time
    expect(server.created.size).toBe(5);
    const final = await queueRepository.listAll();
    expect(final.every((e) => e.status === 'SYNCED')).toBe(true);
    expect(new Set(final.map((e) => e.serverId))).toEqual(new Set(server.created.values()));
    // once SYNCED it is never sent again
    server.requests.length = 0;
    await runPush();
    expect(server.requests).toHaveLength(0);
  });

  it('16.2 cut mid-sync: first batch ACKed, connection dies on the second; only the un-ACKed 5 are re-sent', async () => {
    const ids = await enqueueOrders(25);
    server.dieOnRequestNo = 2;
    const out = await runPush();
    expect(out).toMatchObject({ accepted: 20, paused: 'NETWORK' });
    const mid = await queueRepository.listAll();
    expect(mid.filter((e) => e.status === 'SYNCED')).toHaveLength(20);
    expect(mid.filter((e) => e.status === 'PENDING').map((e) => e.clientId).sort()).toEqual(ids.slice(20).sort());

    server.dieOnRequestNo = null;
    await makeAllDue();
    server.requests.length = 0;
    expect((await runPush()).accepted).toBe(5);
    expect(server.requests).toEqual([ids.slice(20)]); // ACKed items are not re-sent
    expect(server.created.size).toBe(25);
    expect((await queueRepository.listAll()).every((e) => e.status === 'SYNCED')).toBe(true);
  });

  it('8.5 CONFLICT is never auto-retried; resolve-resubmit sends the SERVER price as expectedUnitPrice (same clientId), nothing silently changed before', async () => {
    const [id] = await enqueueOrders(1) as [string];
    server.conflictFor.add(id);
    const first = await runPush();
    expect(first.conflicts).toBe(1);
    const c = (await entries()).find((e) => e.clientId === id)!;
    expect(c.status).toBe('CONFLICT');
    expect((c.payload.lines as { expectedUnitPrice: string }[])[0]!.expectedUnitPrice).toBe('10000.00'); // untouched until the user confirms
    expect(c.lastError?.code).toBe('PRICE_CHANGED');

    server.requests.length = 0;
    await runPush();
    await runPush();
    expect(server.requests).toHaveLength(0); // no auto-retry

    // Confirm the server total, then resubmit. In this fake the client's old expected price was 9000.00 per details.
    server.conflictFor.clear();
    const totals = await queueRepository.resolveConflictResubmit(id);
    expect(totals.serverTotal).toBe('11200.00');
    expect((await queueRepository.listAll())[0]).toMatchObject({ status: 'PENDING', clientId: id });
    expect(((await queueRepository.listAll())[0]!.payload.lines as { expectedUnitPrice: string }[])[0]!.expectedUnitPrice).toBe('10000.00');
    await runPush();
    const sent = server.payloads.get(id)!;
    expect((sent.lines as { expectedUnitPrice: string }[])[0]!.expectedUnitPrice).toBe('10000.00');
    expect(server.requests).toEqual([[id]]);
    expect((await entries())[0]!.status).toBe('SYNCED');
  });

  it('8.4 quota: near the budget -> warning; device full -> typed QueueQuotaError and existing PENDING items intact', async () => {
    const ids = await enqueueOrders(3);
    const mb = 1024 * 1024;
    const usage = (bytes: number) => Object.defineProperty(navigator, 'storage', { value: { estimate: async () => ({ usage: bytes, quota: 1024 ** 4 }) }, configurable: true });
    usage(42 * mb); // 84% of the 50 MB budget
    expect((await publishStorageStatus()).level).toBe('warning');
    await queueRepository.enqueue('order', orderPayload(99)); // still allowed in warning
    await vi.waitFor(() => expect(getLastStorageStatus().level).toBe('warning'));
    usage(51 * mb);
    expect((await publishStorageStatus()).level).toBe('full');

    const quota = Object.assign(new Error('full'), { name: 'QuotaExceededError' });
    const spy = vi.spyOn(db.queue, 'put').mockRejectedValue(quota);
    await expect(queueRepository.enqueue('order', orderPayload(100))).rejects.toBeInstanceOf(QueueQuotaError);
    spy.mockRestore();

    const stored = await queueRepository.listAll();
    expect(stored).toHaveLength(4); // 3 + the one allowed under warning; the failed one wrote nothing
    expect(ids.every((id) => stored.some((e) => e.clientId === id && e.status === 'PENDING'))).toBe(true);
  });

  it('8.4 logout guard + forced path: unsynced blocks logout; forced logout destroys NO unsynced row (own kept encrypted, foreign untouched)', async () => {
    const mine = await enqueueOrders(2);
    await asUser(B);
    const theirs = await enqueueOrders(1);
    await asUser(A);
    expect(await queueRepository.unsyncedCountForLogout()).toBe(2); // B's row is not A's to answer for
    expect(await queueRepository.unsyncedCountAllOwners()).toBe(3);
    await queueRepository.deleteOwnEntries();
    const left = await db.queue.toArray(); // raw: B's row stays sealed under B's key
    expect(left.map((e) => e.clientId).sort()).toEqual([...mine, ...theirs].sort());
  });

  it('8.4 second user on the same device never pushes the first user\'s rows; first user\'s rows survive and sync under their own session', async () => {
    const aIds = await enqueueOrders(3);
    await asUser(B); // A logged out with work unsynced (forced switch), B signs in
    setTokens(tok('b', 'uB'), 'rB');
    const bIds = await enqueueOrders(2);
    await runPush();
    expect(server.sent().sort()).toEqual(bIds.sort());
    expect(server.sent().some((id) => aIds.includes(id))).toBe(false);
    expect((await queueRepository.listAll()).map((e) => e.clientId).sort()).toEqual(bIds.sort()); // B cannot even list A's
    await asUser(A);
    setTokens(tok('a2'), 'rA2');
    await runPush();
    expect(server.sent().filter((id) => aIds.includes(id)).sort()).toEqual(aIds.sort());
  });

  it('8.4 legacy ownerless rows are quarantined: never pushed, never adopted by whoever signs in first, never listed/exported/decrypted, kept', async () => {
    const legacyId = '00000000-0000-4000-8000-000000000001';
    await asUser(A);
    const [own] = await enqueueOrders(1);
    await runPush();
    expect(server.sent()).toEqual([own]);
    await rawStore().put({
      clientId: legacyId, type: 'order', status: 'PENDING', payload: { clientId: legacyId, ...orderPayload(0) },
      createdAt: new Date(Date.now() - 1000).toISOString(), schemaVersion: 1, attemptCount: 0,
    } as never);
    await runPush();
    expect(server.sent()).toEqual([own]); // ownerless never pushed
    expect(JSON.parse(await queueRepository.exportPendingToJson()).items.map((i: { clientId: string }) => i.clientId)).not.toContain(legacyId); // ownerless never exported
    expect(await rawStore().get(legacyId)).toBeDefined(); // preserved
    expect((await queueRepository.listAll()).some((e) => e.clientId === legacyId)).toBe(false);
  });

  it('16.2 token expiry mid-sync (401): ONE refresh, the same batch is resumed with the new token, nothing lost, no attempt burned', async () => {
    const ids = await enqueueOrders(20);
    server.unauthorizedOnce = true;
    const out = await runPush();
    expect(server.refreshCalls).toBe(1);
    expect(server.authHeaders).toEqual([`Bearer ${STALE}`, `Bearer ${FRESH}`]);
    expect(getAccessToken()).toBe(FRESH);
    expect(out).toMatchObject({ accepted: 20, paused: null });
    expect(server.requests).toEqual([ids]);
    const done = await queueRepository.listAll();
    expect(done.every((e) => e.status === 'SYNCED' && e.attemptCount === 1)).toBe(true);
  });

  it('16.2 401 that refresh cannot fix: sync pauses (AUTH), forced-logout handler fires, all items stay PENDING with no attempt counted, resume works after re-login', async () => {
    const ids = await enqueueOrders(4);
    server.unauthorizedOnce = true;
    server.refreshOk = false;
    const unauthorized = vi.fn();
    const off = onUnauthorized(unauthorized);
    const out = await runPush();
    off();
    expect(out.paused).toBe('AUTH');
    expect(unauthorized).toHaveBeenCalledTimes(1);
    expect(server.refreshCalls).toBe(1);
    const held = await queueRepository.listAll();
    expect(held.map((e) => e.clientId).sort()).toEqual([...ids].sort());
    expect(held.every((e) => e.status === 'PENDING' && e.attemptCount === 0 && !e.lastError)).toBe(true);

    setTokens(RELOGIN, 'relogin-refresh');
    expect((await runPush()).accepted).toBe(4);
    expect(server.sent()).toEqual(ids);
  });
});
