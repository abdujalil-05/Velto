import { OfflineKekRetiredError, type OfflineKek } from '@/lib/api/offline-kek';
import type { OfflineSession } from './session';
import { ensureVault } from './vault';

/** Deterministic fake server: one KEK per (version, user, company). The crypto around it is the real Web Crypto. */
export function fakeKekServer(current: { v: number } = { v: 1 }, opts: { retired?: number[]; down?: boolean } = {}) {
  return (session: OfflineSession) => async (version?: number): Promise<OfflineKek> => {
    if (opts.down) throw new Error('offline');
    const v = version ?? current.v;
    if (opts.retired?.includes(v)) {
      throw new OfflineKekRetiredError();
    }
    const seed = new TextEncoder().encode(`${v}|${session.userId}|${session.companyId}`);
    const bytes = new Uint8Array(32);
    seed.forEach((b, i) => {
      bytes[i % 32] = (bytes[i % 32]! * 31 + b + i) & 0xff;
    });
    return { bytes, version: v, currentVersion: current.v };
  };
}

/** Brings the vault up for `session` against the fake server (tests that just need payments to be creatable). */
export async function readyVault(session: OfflineSession): Promise<void> {
  const st = await ensureVault(session, fakeKekServer()(session));
  if (st !== 'ready') throw new Error(`test vault not ready: ${st}`);
}
