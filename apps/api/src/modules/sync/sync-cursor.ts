import { createHash } from 'node:crypto';

/**
 * GET /sync/pull cursor — opaque to clients (base64url JSON).
 *  s: last changeSeq the client has fully applied (decimal string)
 *  f: scope fingerprint (SALES_AGENT: hash of the visible customer/outlet ids; others "all")
 *  t: ms epoch of the first request of a still-running paginated session; present
 *     only on a mid-session cursor (hasMore=true), absent on a terminal one.
 */
export interface SyncCursor {
  s: bigint;
  f: string;
  t?: number;
}

export function encodeCursor(c: SyncCursor): string {
  const body: { v: 1; s: string; f: string; t?: number } = { v: 1, s: c.s.toString(), f: c.f };
  if (c.t !== undefined) body.t = c.t;
  return Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
}

/** Returns null for anything that is not a well-formed v1 cursor (incl. the legacy ISO `since`) → caller does a full resync. */
export function decodeCursor(raw: string | undefined): SyncCursor | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (o.v !== 1 || typeof o.s !== 'string' || !/^\d{1,19}$/.test(o.s) || typeof o.f !== 'string') return null;
    const t = typeof o.t === 'number' && Number.isFinite(o.t) ? o.t : undefined;
    return { s: BigInt(o.s), f: o.f, ...(t !== undefined && { t }) };
  } catch {
    return null;
  }
}

export function scopeFingerprint(outletIds: string[], customerIds: string[]): string {
  const h = createHash('sha256');
  h.update([...outletIds].sort().join(','));
  h.update('|');
  h.update([...customerIds].sort().join(','));
  return h.digest('hex').slice(0, 16);
}

export const ALL_SCOPE = 'all';
