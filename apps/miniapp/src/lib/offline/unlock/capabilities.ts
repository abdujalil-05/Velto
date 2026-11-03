/** Offline Unlock needs IndexedDB, Web Crypto, WebAssembly and Web Workers; anything missing hides the feature (ADR-071 fail-closed). */
export type MissingCapability = 'indexeddb' | 'subtle' | 'wasm' | 'worker';

export interface CapabilityEnv {
  indexedDB?: unknown;
  subtle?: unknown;
  WebAssembly?: unknown;
  Worker?: unknown;
}

export function currentEnv(): CapabilityEnv {
  const g = globalThis as unknown as { indexedDB?: unknown; crypto?: { subtle?: unknown }; WebAssembly?: unknown; Worker?: unknown };
  return { indexedDB: g.indexedDB, subtle: g.crypto?.subtle, WebAssembly: g.WebAssembly, Worker: g.Worker };
}

export function missingCapabilities(env: CapabilityEnv = currentEnv()): MissingCapability[] {
  const out: MissingCapability[] = [];
  if (!env.indexedDB) out.push('indexeddb');
  if (!env.subtle) out.push('subtle');
  if (!env.WebAssembly) out.push('wasm');
  if (!env.Worker) out.push('worker');
  return out;
}

export function offlineUnlockSupported(env?: CapabilityEnv): boolean {
  return missingCapabilities(env).length === 0;
}
