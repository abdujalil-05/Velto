import { describe, expect, it, vi } from 'vitest';
import { ReconciliationAdminService } from './reconciliation-admin.service';
import { ReconciliationBusyException } from './reconciliation-exceptions';

const user = (companyId: string) => ({ id: 'u', companyId }) as never;

function make() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const runDetection = vi.fn(async () => {
    await gate;
    return { runId: 'r' };
  });
  const alertIfDrift = vi.fn(async () => 0);
  const svc = new ReconciliationAdminService({} as never, { runDetection } as never, { alertIfDrift } as never);
  return { svc, release, runDetection };
}

describe('ReconciliationAdminService.runManual concurrency', () => {
  it('parallel manual runs of one company: only one runs, rest 409 RECONCILIATION_BUSY; other company unaffected; slot freed', async () => {
    const { svc, release, runDetection } = make();
    const first = svc.runManual(user('A'));
    const dup = await Promise.allSettled([svc.runManual(user('A')), svc.runManual(user('A'))]);
    expect(dup.every((r) => r.status === 'rejected' && r.reason instanceof ReconciliationBusyException)).toBe(true);
    const other = svc.runManual(user('B'));
    release();
    await Promise.all([first, other]);
    expect(runDetection).toHaveBeenCalledTimes(2);
    await svc.runManual(user('A')); // not leaked
    expect(runDetection).toHaveBeenCalledTimes(3);
  });

  it('slot is freed when the run throws', async () => {
    const { svc, runDetection } = make();
    runDetection.mockRejectedValueOnce(new ReconciliationBusyException());
    await expect(svc.runManual(user('A'))).rejects.toBeInstanceOf(ReconciliationBusyException);
    runDetection.mockResolvedValueOnce({ runId: 'r' } as never);
    await expect(svc.runManual(user('A'))).resolves.toBeDefined();
  });
});
