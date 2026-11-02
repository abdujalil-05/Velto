/** Parses OFFLINE_KEK_PREVIOUS_SECRETS ("<ver>:<secret>;<ver>:<secret>"). Returns error text instead of throwing; never echoes secrets. */
export const MIN_OFFLINE_KEK_SECRET_LENGTH = 32;

export function parsePreviousKekSecrets(raw: string | undefined, currentVersion: number): { map: Map<number, string>; error?: string } {
  const map = new Map<number, string>();
  if (!raw || raw.trim() === '') return { map };
  for (const part of raw.split(';')) {
    if (part.trim() === '') continue;
    const sep = part.indexOf(':');
    const verText = sep < 0 ? '' : part.slice(0, sep);
    const secret = sep < 0 ? '' : part.slice(sep + 1);
    if (!/^[1-9]\d{0,8}$/.test(verText)) return { map, error: 'each entry must be "<version>:<secret>" with an integer version >= 1' };
    const version = Number(verText);
    if (version >= currentVersion) return { map, error: 'previous versions must be lower than OFFLINE_KEK_VERSION' };
    if (map.has(version)) return { map, error: 'duplicate version' };
    if (secret.length < MIN_OFFLINE_KEK_SECRET_LENGTH) return { map, error: `secrets must be at least ${MIN_OFFLINE_KEK_SECRET_LENGTH} chars` };
    map.set(version, secret);
  }
  return { map };
}
