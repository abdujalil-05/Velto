import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from './db';
import { queueRepository } from './queue';
import { setOfflineSession } from './session';
import { readyVault } from './vault-test-helper';
import { resetPreparedSession } from './session-bootstrap';

const fetchPaymentStatuses = vi.fn();
vi.mock('@/lib/api/payments', () => ({
  PAYMENT_STATUSES_LIMIT: 100,
  fetchPaymentStatuses: (...a: unknown[]) => fetchPaymentStatuses(...a),
}));

import { refreshHandoverDecisions } from './handover-sync';

async function seed(n: number) {
  const out: { clientId: string; serverId: string }[] = [];
  for (let i = 0; i < n; i++) {
    const e = await queueRepository.enqueue('payment', {});
    await queueRepository.markSynced(e, `srv-${i}`, 'PENDING_HANDOVER');
    out.push({ clientId: e, serverId: `srv-${i}` });
  }
  return out;
}

describe('refreshHandoverDecisions', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await db.queue.clear();
    setOfflineSession({ userId: 'u1', companyId: 'c1' });
    await readyVault({ userId: 'u1', companyId: 'c1' });
    resetPreparedSession();
  });

  it('chunks >100 awaiting payments into calls of <=100 ids and applies the cashier decision', async () => {
    const rows = await seed(130);
    fetchPaymentStatuses.mockImplementation(async ({ ids }: { ids: string[] }) =>
      ids.map((id) => ({ id, clientId: null, status: id === 'srv-120' ? 'REJECTED' : 'POSTED', handoverAt: null, handoverRejectReason: id === 'srv-120' ? 'no cash' : null })));
    expect(await refreshHandoverDecisions()).toBe(true);
    expect(fetchPaymentStatuses.mock.calls.map((c) => c[0].ids.length)).toEqual([100, 30]);
    const all = await queueRepository.listAll();
    const byServer = new Map(all.map((e) => [e.serverId, e]));
    expect(byServer.get('srv-0')?.paymentStatus).toBe('POSTED');
    expect(byServer.get('srv-120')?.paymentStatus).toBe('REJECTED');
    expect(byServer.get('srv-120')?.handoverRejectReason).toBe('no cash');
    expect(rows).toHaveLength(130);
    // 30s covers only seed() (130 sequential encrypted queue writes); assertions are unchanged.
  }, 30_000);

  it('does not call the server when nothing awaits handover', async () => {
    expect(await refreshHandoverDecisions()).toBe(false);
    expect(fetchPaymentStatuses).not.toHaveBeenCalled();
  });
});
