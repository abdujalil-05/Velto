/**
 * Prisma returns BigInt columns (F4 `changeSeq`) as native bigint, which
 * JSON.stringify refuses ("Do not know how to serialize a BigInt"). Express's
 * res.json() uses JSON.stringify, so one `BigInt.prototype.toJSON` fixes every
 * response — main.ts and the Nest testing module used by e2e alike — and
 * emits the exact decimal string (a JS number would lose precision > 2^53).
 * Idempotent; imported for its side effect by app.module.ts and bootstrap.ts.
 */
export function installBigIntJson(): void {
  const proto = BigInt.prototype as unknown as { toJSON?: () => string };
  if (typeof proto.toJSON === 'function') return;
  Object.defineProperty(BigInt.prototype, 'toJSON', {
    value: function toJSON(this: bigint): string {
      return this.toString();
    },
    configurable: true,
    writable: true,
  });
}

installBigIntJson();
