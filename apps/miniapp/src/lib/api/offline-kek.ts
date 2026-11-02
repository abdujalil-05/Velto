import { ApiError, apiFetch } from './client';

export interface OfflineKek {
  /** Raw 32 bytes. Held in memory for one seal/restore operation only; never persisted. */
  bytes: Uint8Array;
  version: number;
  currentVersion: number;
}

const KEK_TIMEOUT_MS = 8_000;

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class OfflineKekRetiredError extends Error {
  readonly code = 'OFFLINE_KEK_VERSION_RETIRED';
  constructor() {
    super('Offline KEK version retired');
    this.name = 'OfflineKekRetiredError';
  }
}

/**
 * GET /auth/offline-kek[?version=N] - bound server-side to the caller's (userId, companyId). Without `version`
 * returns the current KEK. Throws OfflineKekRetiredError on 410; other errors (offline, 401, 429, malformed) propagate.
 */
export async function fetchOfflineKek(version?: number): Promise<OfflineKek> {
  let res: { kek: string; version: number; currentVersion?: number };
  try {
    res = await apiFetch<{ kek: string; version: number; currentVersion?: number }>(
      version === undefined ? '/auth/offline-kek' : `/auth/offline-kek?version=${version}`,
      { cache: 'no-store', signal: AbortSignal.timeout(KEK_TIMEOUT_MS) },
    );
  } catch (e) {
    if (e instanceof ApiError && (e.status === 410 || e.code === 'OFFLINE_KEK_VERSION_RETIRED')) throw new OfflineKekRetiredError();
    throw e;
  }
  const bytes = fromBase64Url(res.kek);
  if (bytes.length !== 32 || !Number.isInteger(res.version)) throw new Error('OFFLINE_KEK_MALFORMED');
  return { bytes, version: res.version, currentVersion: res.currentVersion ?? res.version };
}
