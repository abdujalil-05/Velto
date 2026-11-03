import type { Queue } from 'bullmq';

/** Test double with BullMQ's jobId semantics: add() with an existing jobId is a silent no-op; terminal entries stay until removed. */
export class FakeBullQueue {
  readonly jobs = new Map<string, { name: string; data: unknown; state: string }>();
  readonly add = async (name: string, data: unknown, opts: { jobId: string }) => {
    if (this.jobs.has(opts.jobId)) return undefined;
    this.jobs.set(opts.jobId, { name, data, state: 'waiting' });
    return undefined;
  };
  readonly getJob = async (id: string) => {
    const j = this.jobs.get(id);
    return j ? { getState: async () => j.state, remove: async () => void this.jobs.delete(id), data: j.data } : undefined;
  };
  setState(id: string, state: string): void {
    const j = this.jobs.get(id);
    if (j) j.state = state;
  }
  asQueue<T>(): Queue<T> {
    return this as unknown as Queue<T>;
  }
}
