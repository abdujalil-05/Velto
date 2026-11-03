import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from './db';
import { queueRepository } from './queue';
import { getOfflineSession, setOfflineSession } from './session';
import { resetPreparedSession } from './session-bootstrap';
import { getVaultStatus, lockVault } from './vault';
import { readyVault } from './vault-test-helper';
import { setTokens } from '@/lib/auth/tokens';
import { onUnauthorized } from '@/lib/api/client';

const pushSync = vi.fn();
const fetchKek = vi.fn();
vi.mock('@/lib/api/offline-kek', async (orig) => ({ ...(await orig<object>()), fetchOfflineKek: (...a: unknown[]) => fetchKek(...a) }));
vi.mock('@/lib/api/sync', () => ({ pullSync: vi.fn(), pushSync: (...a: unknown[]) => pushSync(...a) }));

import { guardTokenOwner, resetPushBatchLimit, runHeldMaintenance, runPush } from './sync-engine-core';

const A = { userId: 'uA', companyId: 'c1' };
const B = { userId: 'uB', companyId: 'c1' };

function jwt(o: { userId: string; companyId: string }): string {
  const enc = (v: unknown) => btoa(JSON.stringify(v)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${enc({ alg: 'HS256' })}.${enc({ sub: o.userId, companyId: o.companyId })}.sig`;
}

describe('token owner guard: a document is only pushed under its owner', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    resetPushBatchLimit();
    await db.queue.clear();
    await db.meta.clear();
    await readyVault(A);
    setOfflineSession(A);
    resetPreparedSession();
    setTokens(jwt(A), 'rA');
  });

  it("A's pending row + token swapped to B -> no push, row stays PENDING for A, UK dropped path signalled; A back -> pushes", async () => {
    const id = (await queueRepository.enqueue('order', { lines: [] })) as string;
    const handler = vi.fn();
    const off = onUnauthorized(handler);
    setTokens(jwt(B), 'rB');

    const out = await runPush();
    expect(pushSync).not.toHaveBeenCalled();
    expect(out.paused).toBe('AUTH');
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ sessionExpired: true }));
    const row = (await queueRepository.listAllOwners()).find((e) => e.clientId === id)!;
    expect(row.status).toBe('PENDING');
    expect(row.userId).toBe('uA');
    off();

    // A signs in again: tokens + session restored -> the row goes out under A.
    setTokens(jwt(A), 'rA2');
    await readyVault(A);
    setOfflineSession(A);
    resetPreparedSession();
    pushSync.mockResolvedValue({ results: [{ clientId: id, status: 'ACCEPTED', id: 'srv' }] });
    await runPush();
    expect(pushSync).toHaveBeenCalledTimes(1);
    expect(pushSync.mock.calls[0]![2]).toEqual(A);
    expect((await queueRepository.listAllOwners()).find((e) => e.clientId === id)!.status).toBe('SYNCED');
  });

  it('storage-event path (guardTokenOwner) detects the swap and is a no-op for the owner', () => {
    expect(guardTokenOwner()).toBe(false);
    setTokens(jwt(B), 'rB');
    expect(guardTokenOwner()).toBe(true);
    expect(getOfflineSession()).toEqual(A); // session end itself is the handler's ordered flow
    expect(getVaultStatus()).toBeDefined();
  });

  it('A session + B token + no A vault row -> maintenance fetches no KEK and writes no vault row', async () => {
    await db.vault.clear();
    lockVault();
    setTokens(jwt(B), 'rB');
    await runHeldMaintenance();
    expect(fetchKek).not.toHaveBeenCalled();
    expect(await db.vault.count()).toBe(0);
  });
});
