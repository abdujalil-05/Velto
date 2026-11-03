import type { UnlockKdfParams } from '../db';

export type DeriveFn = (passphrase: string, salt: Uint8Array, params: UnlockKdfParams, ownerSecret: string) => Promise<Uint8Array>;

/** Default deriver: Argon2id in a same-origin dedicated worker (keeps the UI thread free for ~64 MiB work). One worker per call, terminated afterwards. */
export const workerDerive: DeriveFn = (passphrase, salt, params, ownerSecret) =>
  new Promise<Uint8Array>((resolve, reject) => {
    const enc = new TextEncoder();
    const password = enc.encode(passphrase);
    const secret = enc.encode(ownerSecret);
    const worker = new Worker(new URL('./kdf.worker.ts', import.meta.url));
    const done = () => worker.terminate();
    worker.onmessage = (e: MessageEvent<{ ok: boolean; out?: Uint8Array; oom?: boolean }>) => {
      done();
      if (e.data.ok && e.data.out) resolve(e.data.out);
      else reject(new Error(e.data.oom ? 'KDF_OOM' : 'KDF_FAILED'));
    };
    worker.onerror = () => {
      done();
      password.fill(0);
      secret.fill(0);
      reject(new Error('KDF_FAILED'));
    };
    worker.postMessage({ password, salt, secret, params }, [password.buffer, secret.buffer]);
  });

/** Preferred and floor parameters (OWASP: Argon2id m=19 MiB,t=2,p=1 minimum). m in KiB. */
export const TARGET_PARAMS: UnlockKdfParams = { m: 65536, t: 3, p: 1, v: 19 };
export const FLOOR_PARAMS: UnlockKdfParams = { m: 19456, t: 2, p: 1, v: 19 };
