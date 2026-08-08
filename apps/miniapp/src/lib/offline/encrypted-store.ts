import type { Table } from 'dexie';
import { decryptValue, encryptValue } from './crypto';
import type { RawRow } from './db';

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

  async bulkPut(items: T[]): Promise<void> {
    if (items.length === 0) return;
    const rows = await Promise.all(items.map((item) => this.toRow(item)()));
    await this.table.bulkPut(rows);
  }

  async put(item: T): Promise<void> {
    await this.table.put(await this.toRow(item)());
  }

  async get(key: Key): Promise<T | undefined> {
    const row = await this.table.get(key);
    return row ? decryptValue<T>(row._enc) : undefined;
  }

  async toArray(): Promise<T[]> {
    const rows = await this.table.toArray();
    return Promise.all(rows.map((row) => decryptValue<T>(row._enc)));
  }

  async count(): Promise<number> {
    return this.table.count();
  }

  async clear(): Promise<void> {
    await this.table.clear();
  }
}
