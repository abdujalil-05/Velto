// 10.2 "Lokal baza shifrlangan holda saqlanadi" — AES-GCM via Web Crypto,
// applied per-row by `encrypted-store.ts`. Key material is a random 256-bit
// key generated once on-device and kept in localStorage next to the JWT
// tokens (lib/auth/tokens.ts) — the same trust boundary the rest of this
// app already relies on. Nothing stored client-side can defend against a
// fully compromised device, and there's no server-issued device-key
// infrastructure to do better; this is the honest MVP-grade reading of the
// requirement (protects the DB file at rest from casual inspection/backup
// extraction), not a claim of stronger guarantees.

const DB_KEY_STORAGE_KEY = 'velto.dbKey';
const ALGO = 'AES-GCM';
const IV_LENGTH = 12;

let cachedKey: Promise<CryptoKey> | null = null;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function loadOrCreateRawKey(): Promise<Uint8Array> {
  const stored = window.localStorage.getItem(DB_KEY_STORAGE_KEY);
  if (stored) return base64ToBytes(stored);

  const raw = new Uint8Array(32);
  window.crypto.getRandomValues(raw);
  window.localStorage.setItem(DB_KEY_STORAGE_KEY, bytesToBase64(raw));
  return raw;
}

function getDeviceKey(): Promise<CryptoKey> {
  if (!cachedKey) {
    cachedKey = loadOrCreateRawKey().then((raw) =>
      window.crypto.subtle.importKey('raw', raw as BufferSource, ALGO, false, ['encrypt', 'decrypt']),
    );
  }
  return cachedKey;
}

export interface EncryptedBlob {
  iv: Uint8Array;
  ct: ArrayBuffer;
}

/** Encrypts an arbitrary JSON-serializable value into a blob Dexie can store directly (structured clone supports ArrayBuffer/Uint8Array natively — no base64 needed at rest). */
export async function encryptValue(value: unknown): Promise<EncryptedBlob> {
  const key = await getDeviceKey();
  const iv = window.crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ct = await window.crypto.subtle.encrypt({ name: ALGO, iv }, key, plaintext);
  return { iv, ct };
}

export async function decryptValue<T>(blob: EncryptedBlob): Promise<T> {
  const key = await getDeviceKey();
  const plaintext = await window.crypto.subtle.decrypt({ name: ALGO, iv: blob.iv as BufferSource }, key, blob.ct);
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

/** Wipes the device key (e.g. on logout) — any previously encrypted rows become unreadable, which is fine since the whole local DB is cleared alongside it (see db.ts's `clearAll`). */
export function clearDeviceKey(): void {
  window.localStorage.removeItem(DB_KEY_STORAGE_KEY);
  cachedKey = null;
}
