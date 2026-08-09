import type { Table } from 'dexie';
import { decryptValue, encryptValue, type EncryptedBlob } from './crypto';
import type { RawRow } from './db';

/** Boxed so `Promise.all` over it stays typed as an object array rather than collapsing `T | undefined` through `Awaited<>`. */
interface Decoded<T> {
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
  ) {
    this.table = table;
  }

  private toRow(item: T) {
    return async () => {
      const plain: Record<string, unknown> = {};
      for (const field of this.keyFields) plain[field] = item[field];
      return { ...plain, _enc: await encryptValue(item) };
    };
  }

  /**
   * Encrypts rows *outside* any Dexie transaction — awaiting Web Crypto
   * inside an open Dexie transaction drops out of its zone and the
   * transaction commits/aborts early (TransactionInactiveError). Callers that
   * need an atomic clear+repopulate encode first, then write inside
   * `db.transaction` using `bulkPutRows` (see repository.ts's `applyPull`).
   */
  async encodeRows(items: T[]): Promise<(RawRow & Record<string, unknown>)[]> {
    return Promise.all(items.map((item) => this.toRow(item)()));
  }

  async bulkPutRows(rows: (RawRow & Record<string, unknown>)[]): Promise<void> {
    if (rows.length === 0) return;
    await this.table.bulkPut(rows);
  }

  async bulkPut(items: T[]): Promise<void> {
    if (items.length === 0) return;
    await this.table.bulkPut(await this.encodeRows(items));
  }

  async put(item: T): Promise<void> {
    await this.table.put(await this.toRow(item)());
  }

  async get(key: Key): Promise<T | undefined> {
    const row = await this.table.get(key);
    if (!row) return undefined;
    return (await tryDecrypt<T>(row._enc)).value;
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
    const decoded = await Promise.all(rows.map((row) => tryDecrypt<T>(row._enc)));
    const out: T[] = [];
    for (const { value } of decoded) if (value !== undefined) out.push(value);
    return out;
  }

  async count(): Promise<number> {
    return this.table.count();
  }

  async clear(): Promise<void> {
    await this.table.clear();
  }
}
