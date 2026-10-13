import { beforeEach, describe, expect, it, vi } from 'vitest';

const pushSync = vi.fn();
const markSynced = vi.fn();
const markFailed = vi.fn();

vi.mock('@/lib/api/sync', () => ({ pullSync: vi.fn(), pushSync: (...a: unknown[]) => pushSync(...a) }));
vi.mock('./repository', () => ({ applyPull: vi.fn(), getCursor: vi.fn() }));
vi.mock('./storage-budget', () => ({ enforceStorageBudget: vi.fn() }));
vi.mock('./queue', () => ({
  queueRepository: {
    listPending: vi.fn(async () => [
      { type: 'visit', clientId: 'v1', payload: {} },
      { type: 'order', clientId: 'o1', payload: {} },
    ]),
    markSynced: (...a: unknown[]) => markSynced(...a),
    markFailed: (...a: unknown[]) => markFailed(...a),
    pruneOld: vi.fn(),
  },
}));

import { runPush } from './sync-engine-core';

describe('runPush server GPS verdicts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('collects gpsStatus only for entries where the server sent one', async () => {
    pushSync.mockResolvedValue({
      results: [
        { clientId: 'v1', status: 'ACCEPTED', gpsStatus: 'OUTSIDE_RADIUS', distanceM: '350.00' },
        { clientId: 'o1', status: 'ACCEPTED' },
      ],
    });
    const outcome = await runPush();
    expect(outcome.accepted).toBe(2);
    expect(outcome.visitGps).toEqual([{ clientId: 'v1', gpsStatus: 'OUTSIDE_RADIUS', distanceM: '350.00' }]);
  });
});
