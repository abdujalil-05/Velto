import type { Table } from 'dexie';
import { decryptValue, encryptValue, type EncryptedBlob } from './crypto';
import type { RawRow } from './db';

/** Boxed so `Promise.all` over it stays typed as an object array rather than collapsing `T | undefined` through `Awaited<>`. */
export interface Decoded<T> {
  value?: T;
}

async function tryDecrypt<T>(blob: EncryptedBlob): Promise<Decoded<T>> {
  try {
    return { value: await decryptValue<T>(blob) };
  } catch {
    // AES-GCM auth-tag failure (wrong/rotated device key) or corrupt blob.
    console.error('[offline] dropping a row that could not be decrypted');
    return {};
  }
}

/**
 * Optional per-table codec. `encode` returns a blob to use instead of the device
 * key (null = use the device key). `decode` returns null for rows it does not own
 * (device-key rows), or a Decoded — empty when the row is locked/unreadable, in
 * which case the row is skipped silently (it is never deleted).
 */
export interface RowCodec<T> {
  /** Must THROW (not return null) for rows that may never be written under the device key. */
  encode(item: T, force?: boolean): Promise<EncryptedBlob | null>;
  decode(row: RawRow & Record<string, unknown>): Promise<Decoded<T> | null>;
}

/**
 * Generic read/write wrapper around one Dexie table: callers work with
 * plain decrypted objects of type `T`; every row is persisted as its
 * declared index fields in plaintext (`keyFields`, so Dexie's own indexed
 * queries still work) plus the full object AES-GCM-encrypted under `_enc`.
 * Cast to `Table<RawRow, Key>` at construction to sidestep generic-variance
 * friction between this and each table's more specifically typed row shape
 * in db.ts — the public API here is what stays fully typed.
 */
export class EncryptedStore<T extends object, Key> {
  private readonly table: Table<RawRow & Record<string, unknown>, Key>;

  constructor(
    table: Table<RawRow & Record<string, unknown>, Key>,
    private readonly keyFields: (keyof T & string)[],
    /** Plaintext columns that win over the encrypted copy on read when present (set by a Dexie upgrade that cannot encrypt). */
    private readonly plaintextWins: (keyof T & string)[] = [],
    private readonly codec?: RowCodec<T>,
  ) {
    this.table = table;
  }

  private toRow(item: T, force = false, deviceKey = false) {
    return async () => {
      const plain: Record<string, unknown> = {};
      for (const field of this.keyFields) plain[field] = item[field];
      const blob = deviceKey ? await encryptValue(item) : ((await this.codec?.encode(item, force)) ?? (await encryptValue(item)));
      return { ...plain, _enc: blob };
    };
  }

  private async decodeRow(row: RawRow & Record<string, unknown>): Promise<Decoded<T>> {
    return (await this.codec?.decode(row)) ?? tryDecrypt<T>(row._enc);
  }

  /**
   * Encrypts rows *outside* any Dexie transaction — awaiting Web Crypto
   * inside an open Dexie transaction drops out of its zone and the
   * transaction commits/aborts early (TransactionInactiveError). Callers that
   * need an atomic clear+repopulate encode first, then write inside
   * `db.transaction` using `bulkPutRows` (see repository.ts's `applyPull`).
   */
  async encodeRows(items: T[], force = false): Promise<(RawRow & Record<string, unknown>)[]> {
    return Promise.all(items.map((item) => this.toRow(item, force)()));
  }

  async bulkPutRows(rows: (RawRow & Record<string, unknown>)[]): Promise<void> {
    if (rows.length === 0) return;
    await this.table.bulkPut(rows);
  }

  async bulkPut(items: T[]): Promise<void> {
    if (items.length === 0) return;
    await this.table.bulkPut(await this.encodeRows(items));
  }

  /** `force` asks the codec to use its own key even for rows it would not normally cover (logout/login migration). */
  async put(item: T, opts: { force?: boolean; deviceKey?: boolean } = {}): Promise<void> {
    await this.table.put(await this.toRow(item, opts.force, opts.deviceKey)());
  }

  private overlay(row: RawRow & Record<string, unknown>, value: T | undefined): T | undefined {
    if (value === undefined || this.plaintextWins.length === 0) return value;
    const out = { ...value } as Record<string, unknown>;
    for (const f of this.plaintextWins) if (row[f] !== undefined && row[f] !== null) out[f] = row[f];
    return out as T;
  }

  async get(key: Key): Promise<T | undefined> {
    const row = await this.table.get(key);
    if (!row) return undefined;
    return this.overlay(row, (await this.decodeRow(row)).value);
  }

  /**
   * A row that fails to decrypt is skipped, not thrown on. The device key
   * lives in localStorage while the rows live in IndexedDB, and mobile
   * WebViews evict those two stores independently (iOS 7-day cap, "clear
   * site data" variants) — with a throw here, a single unreadable row makes
   * *every* screen and the whole sync loop fail permanently, with no path
   * back. Skipping degrades to "reference data missing until the next pull
   * refills it", which is recoverable. Unreadable rows are already
   * unrecoverable ciphertext, so nothing readable is discarded.
   */
  async toArray(): Promise<T[]> {
    const rows = await this.table.toArray();
    const decoded = await Promise.all(rows.map((row) => this.decodeRow(row)));
    const out: T[] = [];
    decoded.forEach(({ value }, i) => {
      const v = this.overlay(rows[i]!, value);
      if (v !== undefined) out.push(v);
    });
    return out;
  }

  async delete(key: Key): Promise<void> {
    await this.table.delete(key);
  }

  async bulkDelete(keys: Key[]): Promise<void> {
    if (keys.length === 0) return;
    await this.table.bulkDelete(keys);
  }

  async count(): Promise<number> {
    return this.table.count();
  }

  async clear(): Promise<void> {
    await this.table.clear();
  }
}
