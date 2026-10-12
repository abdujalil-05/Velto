import { describe, expect, it, vi } from 'vitest';
import type { Job, Queue } from 'bullmq';
import { TenantContext } from '../tenant/tenant-context';
import { getTraceId, runWithTraceId } from '../trace/trace-context';
import { addTracedJob, runJobWithTrace, type TraceableJobData } from './trace-job';

interface Data extends TraceableJobData {
  id: string;
}

describe('trace-job', () => {
  it('adds the current trace id to job data', () => {
    const add = vi.fn();
    runWithTraceId('trace-abc12345', () => addTracedJob({ add } as unknown as Queue<Data>, 'x', { id: '1' }));
    expect(add).toHaveBeenCalledWith('x', { id: '1', traceId: 'trace-abc12345' });
  });

  it('generates a trace id outside a request', () => {
    const add = vi.fn();
    addTracedJob({ add } as unknown as Queue<Data>, 'x', { id: '1' });
    expect(add.mock.calls[0]![1].traceId).toEqual(expect.any(String));
  });

  it('propagates the request trace id into a job enqueued via TenantContext.afterCommit', async () => {
    const add = vi.fn();
    const afterCommit: Array<() => unknown> = [];
    // Mirrors TenantPrismaService.run: callbacks are registered inside the tenant context, flushed after it, still inside the request's trace context.
    await runWithTraceId('known-trace-id-123', async () => {
      TenantContext.run({ companyId: 'c1', tx: {} as never, afterCommit }, () => {
        TenantContext.afterCommit(() => addTracedJob({ add } as unknown as Queue<Data>, 'x', { id: '1' }));
      });
      for (const cb of afterCommit) await cb();
    });
    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith('x', { id: '1', traceId: 'known-trace-id-123' });
  });

  it('generates a different fresh id per call outside any trace context', () => {
    const add = vi.fn();
    addTracedJob({ add } as unknown as Queue<Data>, 'x', { id: '1' });
    addTracedJob({ add } as unknown as Queue<Data>, 'x', { id: '1' });
    expect(add.mock.calls[0]![1].traceId).not.toBe(add.mock.calls[1]![1].traceId);
  });

  it('runs the handler in the job trace context, tolerating old jobs without one', async () => {
    const withId = await runJobWithTrace({ data: { id: '1', traceId: 'trace-abc12345' } } as Job<Data>, async () => getTraceId());
    expect(withId).toBe('trace-abc12345');
    const legacy = await runJobWithTrace({ data: { id: '1' } } as Job<Data>, async () => getTraceId());
    expect(legacy).toEqual(expect.any(String));
  });
});
