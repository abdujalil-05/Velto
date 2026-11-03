import { describe, expect, it, vi } from 'vitest';
import { ImportRecoveryService } from '../../modules/import/import-recovery.service';
import { systemPrisma } from '@velto/database';
import { fetchAllById } from './fetch-all-by-id';

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: String(i).padStart(5, '0') }));
const pager = (all: Array<{ id: string }>) => vi.fn(async ({ take, cursor, skip }: { take: number; cursor?: { id: string }; skip?: number }) => {
  const start = cursor ? all.findIndex((r) => r.id === cursor.id) + (skip ?? 0) : 0;
  return all.slice(start, start + take);
});

describe('fetchAllById', () => {
  it('returns every row beyond the first 100 (151 rows across tenants)', async () => {
    const all = rows(151);
    expect(await fetchAllById(pager(all))).toHaveLength(151);
  });

  it('ImportRecoveryService.sweep inspects jobs beyond the first page', async () => {
    const all = rows(151).map((r) => ({ ...r, companyId: 'c', createdBy: null }));
    const spy = vi.spyOn(systemPrisma.importJob, 'findMany').mockImplementation(((args: Parameters<ReturnType<typeof pager>>[0]) => pager(all)(args)) as never);
    const getJob = vi.fn().mockResolvedValue({ getState: async () => 'active' });
    const sweepSvc = new ImportRecoveryService({} as never, { add: vi.fn(), getJob } as never);
    await sweepSvc.sweep();
    spy.mockRestore();
    expect(getJob).toHaveBeenCalledTimes(151);
    expect(getJob).toHaveBeenCalledWith('import-00150');
  });
});
