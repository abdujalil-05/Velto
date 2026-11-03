import { argon2id } from 'hash-wasm';
import type { UnlockKdfParams } from '../db';

/** Argon2id (hash-wasm, WASM) -> 32 raw bytes. `secret` binds the output to the entry owner. Runs inside the worker (kdf.worker.ts) in the app, directly in tests. */
export async function argon2Derive(password: Uint8Array, salt: Uint8Array, secret: Uint8Array, params: UnlockKdfParams): Promise<Uint8Array> {
  return argon2id({
    password,
    salt,
    secret,
    iterations: params.t,
    parallelism: params.p,
    memorySize: params.m,
    hashLength: 32,
    outputType: 'binary',
  });
}
