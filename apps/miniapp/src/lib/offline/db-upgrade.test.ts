import Dexie from 'dexie';
import { describe, expect, it } from 'vitest';
import { encryptValue } from './crypto';

describe('Dexie v2 -> v3 upgrade', () => {
  it('keeps existing PENDING items byte-for-byte; legacy ownerless rows are quarantined, never adopted', async () => {
    const v2 = new Dexie('velto-miniapp');
    v2.version(1).stores({
      products: 'id, sku, name, categoryId', packagings: 'id, productId', prices: '[priceListId+productId], productId',
      customers: 'id, code, name, tin', outlets: 'id, customerId', stock: '[productId+warehouseId], productId', categories: 'id, parentId',
      balances: 'customerId', routes: 'id, weekday', routeStops: 'id, routeId, outletId', queue: 'clientId, type, status, createdAt', meta: 'key',
    });
    v2.version(2).stores({ customers: 'id, code, name' });
    const legacy = { clientId: 'legacy-1', type: 'order', status: 'PENDING', payload: { clientId: 'legacy-1', customerId: 'c' }, createdAt: '2026-10-01T00:00:00.000Z' };
    await v2.table('queue').put({ clientId: 'legacy-1', type: 'order', status: 'PENDING', createdAt: legacy.createdAt, _enc: await encryptValue(legacy) });
    v2.close();

    const { db } = await import('./db');
    const { queueRepository } = await import('./queue');
    const { setOfflineSession } = await import('./session');
    const { prepareOfflineSession, resetPreparedSession } = await import('./session-bootstrap');

    await db.open();
    expect(db.verno).toBe(7);
    expect(await db.queue.count()).toBe(1);

    setOfflineSession({ userId: 'u1', companyId: 'c1' });
    await (await import('./vault-test-helper')).readyVault({ userId: 'u1', companyId: 'c1' });
    expect(await queueRepository.listAll()).toEqual([]); // unowned: not shown, not pushable
    await prepareOfflineSession();
    expect(await queueRepository.listAll()).toEqual([]); // still not user u1's work
    expect(await queueRepository.listPushable(20)).toEqual([]); // never pushed
    expect(await queueRepository.unsyncedCountForLogout()).toBe(0); // not u1's: does not block the gate

    // another user signing in does not adopt it either
    setOfflineSession({ userId: 'u2', companyId: 'c1' });
    resetPreparedSession();
    await prepareOfflineSession();
    expect(await queueRepository.listAll()).toEqual([]);

    expect(JSON.parse(await queueRepository.exportPendingToJson()).items).toEqual([]); // never exported
    expect(await db.queue.count()).toBe(1); // never deleted by a non-creator
  });

  it('a legacy row whose (unauthenticated) payload names the current user is NOT claimed: nobody adopts ownerless rows', async () => {
    const { db } = await import('./db');
    const { queueRepository } = await import('./queue');
    const { setOfflineSession } = await import('./session');
    const mk = async (id: string, agentId: string) => {
      const e = { clientId: id, type: 'visit', status: 'PENDING', payload: { clientId: id, agentId }, createdAt: '2026-10-01T00:00:00.000Z' };
      await db.queue.put({ clientId: id, type: 'visit', status: 'PENDING', createdAt: e.createdAt, _enc: await encryptValue(e) } as never);
    };
    await db.queue.clear();
    await mk('mine', 'u1');
    await mk('theirs', 'u9');
    setOfflineSession({ userId: 'u1', companyId: 'c1' });
    await (await import('./vault-test-helper')).readyVault({ userId: 'u1', companyId: 'c1' });
    const { prepareOfflineSession } = await import('./session-bootstrap');
    await prepareOfflineSession();
    expect(await queueRepository.listAll()).toEqual([]);
    expect(await queueRepository.listPushable(20)).toEqual([]);
    expect(JSON.parse(await queueRepository.exportPendingToJson()).items).toEqual([]);
    expect(await db.queue.count()).toBe(2); // both preserved untouched
    expect((await db.queue.get('mine'))!.userId).toBeUndefined();
  });
});
