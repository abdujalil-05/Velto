import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/sync', () => ({ pullSync: vi.fn(), pushSync: vi.fn() }));

import { clearDeviceKey, hasDeviceKey } from './crypto';
import { db } from './db';
import { bringUpVault } from './held-seal';
import { offlineRepository } from './repository';
import { setOfflineSession } from './session';
import { resetPreparedSession } from './session-bootstrap';
import { lockVault, refreshLegacyPaymentRows } from './vault';
import { fakeKekServer } from './vault-test-helper';

/** F3: losing the network (or re-running the bring-up effect) must never wipe the private reference cache. */
const A = { userId: 'uA', companyId: 'c1' };
const cur = { v: 1 };
const customer = { id: 'cust-1', code: 'C1', name: 'Cached Customer', phone: null, priceListId: null, paymentTermDays: 0, isBlocked: false, cachedBalance: '1.00', isActive: true } as never;

const setOnline = (v: boolean) => vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(v);

describe('bring-up never wipes the cache without a proven connection', () => {
  beforeEach(async () => {
    cur.v = 1;
    lockVault();
    setOfflineSession(null);
    for (const t of db.tables) await t.clear();
    window.localStorage.clear();
    clearDeviceKey();
    await refreshLegacyPaymentRows(null);
    setOfflineSession(A);
    resetPreparedSession();
  });
  afterEach(() => vi.restoreAllMocks());

  it('online first bring-up still drops the unused device key and the cache it encrypts (refilled by the next pull)', async () => {
    await offlineRepository.customers.bulkPut([customer]);
    expect(hasDeviceKey()).toBe(true);
    const r = await bringUpVault(A, fakeKekServer(cur)(A));
    expect(r.deviceKeyDropped).toBe(true);
    expect(await db.customers.count()).toBe(0);
  });

  it('a repeated bring-up (UK already in memory, e.g. effect re-run after a navigation) keeps the cache', async () => {
    await bringUpVault(A, fakeKekServer(cur)(A));
    await offlineRepository.customers.bulkPut([customer]); // pull after bring-up re-creates the device key
    expect(hasDeviceKey()).toBe(true);
    const r = await bringUpVault(A, fakeKekServer(cur)(A));
    expect(r.deviceKeyDropped).toBe(false);
    expect(await db.customers.count()).toBe(1);
    expect(hasDeviceKey()).toBe(true);
  });

  it('browser reports offline: the cache is kept even if the vault has to be opened again', async () => {
    await offlineRepository.customers.bulkPut([customer]);
    setOnline(false);
    const r = await bringUpVault(A, fakeKekServer(cur)(A));
    expect(r.deviceKeyDropped).toBe(false);
    expect(await db.customers.count()).toBe(1);
    expect(hasDeviceKey()).toBe(true);
  });
});
