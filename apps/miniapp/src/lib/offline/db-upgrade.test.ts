import Dexie from 'dexie';
import { describe, expect, it } from 'vitest';
import { encryptValue } from './crypto';

describe('Dexie v2 -> v3 upgrade', () => {
  it('keeps existing PENDING items byte-for-byte; legacy rows are hidden until adopted by the first user', async () => {
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
    const { prepareOfflineSession } = await import('./session-bootstrap');

    await db.open();
    expect(db.verno).toBe(3);
    expect(await db.queue.count()).toBe(1);

    setOfflineSession({ userId: 'u1', companyId: 'c1' });
    expect(await queueRepository.listAll()).toEqual([]); // unowned: not shown, not pushable
    await prepareOfflineSession();
    const [adopted] = await queueRepository.listAll();
    expect(adopted).toMatchObject({ clientId: 'legacy-1', status: 'PENDING', attemptCount: 0, userId: 'u1', companyId: 'c1' });
    expect(adopted?.payload).toMatchObject({ customerId: 'c' });
  });
});
