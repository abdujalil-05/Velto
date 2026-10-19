import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTokens, getRefreshToken, setTokens } from '@/lib/auth/tokens';
import { apiFetch, onUnauthorized } from '@/lib/api/client';
import { db } from './db';
import { EncryptedStore } from './encrypted-store';
import { queueRepository } from './queue';
import { clearRevokedInfo, getRevokedInfo, handleSessionRevoked } from './revoke-wipe';
import { setOfflineSession } from './session';
import { resetPreparedSession } from './session-bootstrap';
import { resetPushBatchLimit, runPush } from './sync-engine-core';

const A = { userId: 'uA', companyId: 'c1' };
const B = { userId: 'uB', companyId: 'c1' };
const asUser = (u: typeof A) => {
  setOfflineSession(u);
  resetPreparedSession();
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let refresh: () => Response | Promise<Response>;
let pushCalls = 0;
let off: () => void;

const fakeFetch = async (url: string | URL | Request) => {
  const u = String(url);
  if (u.endsWith('/auth/refresh')) return refresh();
  if (u.endsWith('/sync/push')) {
    pushCalls += 1;
    return json(201, { results: [] });
  }
  return json(401, { code: 'UNAUTHORIZED', message: { uz: '', ru: '', en: '' } });
};
const rejected = (status: number) => () => json(status, { code: status === 403 ? 'AUTH_ACCOUNT_BLOCKED' : 'AUTH_SESSION_EXPIRED', message: { uz: '', ru: '', en: '' } });
const blocked = rejected(403);

const order = { customerId: 'c', lines: [{ productId: 'p', packagingId: 'k', qty: 1, expectedUnitPrice: '1.00' }] };
async function seedCache() {
  await new EncryptedStore<Record<string, unknown>, string>(db.customers as never, ['id', 'code', 'name']).put({ id: 'c1', code: 'C', name: 'Cust' });
  await new EncryptedStore<Record<string, unknown>, string>(db.products as never, ['id', 'sku', 'name', 'categoryId']).put({ id: 'p1', sku: 's', name: 'P', categoryId: null });
  await db.meta.put({ key: 'pull:c1:uA', value: 'cursor' });
}
const cacheEmpty = async () => (await db.customers.count()) + (await db.products.count()) + (await db.meta.where('key').startsWith('pull:').count()) === 0;
const revokeOnUnauthorized = () => onUnauthorized((i) => { if (i.revoked) void handleSessionRevoked(); });

describe('revoke wipe (TZ 8.6, ADR-022)', () => {
  beforeEach(async () => {
    vi.stubGlobal('fetch', fakeFetch);
    pushCalls = 0;
    resetPushBatchLimit();
    await db.queue.clear();
    await db.meta.clear();
    await db.customers.clear();
    await db.products.clear();
    clearRevokedInfo();
    clearTokens();
    setTokens('stale', 'refresh-1');
    asUser(A);
    off = revokeOnUnauthorized();
  });
  afterEach(() => {
    off();
    vi.unstubAllGlobals();
  });

  it('refresh 403 AUTH_ACCOUNT_BLOCKED: cache wiped, unsynced docs quarantined and never pushed, tokens dropped', async () => {
    refresh = blocked;
    await seedCache();
    const id = await queueRepository.enqueue('order', order);
    await expect(apiFetch('/auth/me')).rejects.toBeTruthy();
    await handleSessionRevoked();

    expect(await cacheEmpty()).toBe(true);
    expect(getRefreshToken()).toBeNull();
    const rows = await queueRepository.listRevokedFor(A);
    expect(rows.map((r) => r.clientId)).toEqual([id]);
    expect(getRevokedInfo()).toMatchObject(A);

    asUser(A); // even the same owner signing in again: nothing is pushed
    expect(await queueRepository.listPushable(20)).toEqual([]);
    await runPush();
    expect(pushCalls).toBe(0);
  });

  it('expired/rotated refresh (401 AUTH_SESSION_EXPIRED): NO wipe, doc stays PENDING and pushes after re-login', async () => {
    refresh = rejected(401);
    await seedCache();
    const id = await queueRepository.enqueue('order', order);
    await expect(apiFetch('/auth/me')).rejects.toBeTruthy();
    expect(await cacheEmpty()).toBe(false);
    expect(getRevokedInfo()).toBeNull();
    setTokens('new-access', 'new-refresh');
    asUser(A);
    expect((await queueRepository.listPushable(20)).map((e) => e.clientId)).toEqual([id]);
  });

  it('same user signing in after the block: sees own quarantine, release (confirmed) makes it pushable', async () => {
    const id = await queueRepository.enqueue('order', order);
    await handleSessionRevoked();
    asUser(A);
    expect((await queueRepository.listOwnQuarantined()).map((e) => e.clientId)).toEqual([id]);
    expect(await queueRepository.listPushable(20)).toEqual([]);
    asUser(B);
    expect(await queueRepository.listOwnQuarantined()).toEqual([]);
    asUser(A);
    expect(await queueRepository.releaseOwnQuarantine()).toBe(1);
    expect((await queueRepository.listPushable(20)).map((e) => e.clientId)).toEqual([id]);
  });

  it('network error / 5xx on refresh: nothing wiped, tokens kept, doc still pushable', async () => {
    await seedCache();
    const id = await queueRepository.enqueue('order', order);
    for (const r of [() => { throw new TypeError('Failed to fetch'); }, () => json(503, {})]) {
      refresh = r as never;
      await expect(apiFetch('/auth/me')).rejects.toBeTruthy();
    }
    expect(await cacheEmpty()).toBe(false);
    expect(getRefreshToken()).toBe('refresh-1');
    expect(getRevokedInfo()).toBeNull();
    expect((await queueRepository.listPushable(20)).map((e) => e.clientId)).toEqual([id]);
  });

  it('repeated / concurrent wipe is idempotent and loses no document', async () => {
    refresh = rejected(401);
    await seedCache();
    await queueRepository.enqueue('order', order);
    await queueRepository.enqueue('visit', { outletId: 'o' });
    await Promise.all([handleSessionRevoked(), handleSessionRevoked()]);
    await handleSessionRevoked();
    expect(await queueRepository.listRevokedFor(A)).toHaveLength(2);
    expect(await cacheEmpty()).toBe(true);
  });

  it('SYNCED history is dropped, no queue row -> no revoke notice', async () => {
    await seedCache();
    const id = await queueRepository.enqueue('order', order);
    await queueRepository.markSynced(id, 'srv-1');
    expect(await handleSessionRevoked()).toBeNull();
    expect(await queueRepository.queueRowCount()).toBe(0);
    expect(getRevokedInfo()).toBeNull();
  });

  it('another user on the device never sees or exports the revoked owner\'s documents; export/discard work for the owner', async () => {
    await queueRepository.enqueue('order', order);
    await handleSessionRevoked();
    asUser(B);
    expect(await queueRepository.listAll()).toEqual([]);
    expect(await queueRepository.listQuarantined()).toEqual([]);
    expect(JSON.parse(await queueRepository.exportPendingToJson()).items).toEqual([]);
    expect(await queueRepository.unsyncedCountForLogout()).toBe(0);

    const exported = JSON.parse(await queueRepository.exportRevokedToJson(A));
    expect(exported.items).toHaveLength(1);
    await queueRepository.discardRevokedFor(B);
    expect(await queueRepository.listRevokedFor(A)).toHaveLength(1);
    await queueRepository.discardRevokedFor(A);
    expect(await queueRepository.queueRowCount()).toBe(0);
  });
});
