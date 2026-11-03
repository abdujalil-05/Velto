import { argon2Derive } from './kdf-core';
import type { UnlockKdfParams } from '../db';

interface Req {
  password: Uint8Array;
  salt: Uint8Array;
  secret: Uint8Array;
  params: UnlockKdfParams;
}

const ctx = self as unknown as { onmessage: ((e: MessageEvent<Req>) => void) | null; postMessage: (m: unknown, t?: Transferable[]) => void };

ctx.onmessage = (e) => {
  const { password, salt, secret, params } = e.data;
  argon2Derive(password, salt, secret, params)
    .then((out) => ctx.postMessage({ ok: true, out }, [out.buffer as ArrayBuffer]))
    .catch((err: unknown) => ctx.postMessage({ ok: false, oom: err instanceof RangeError || /memory|alloc/i.test(String((err as Error)?.message)) }))
    .finally(() => {
      password.fill(0);
      secret.fill(0);
    });
};
