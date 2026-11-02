/** Known example/CI placeholders that must never be a production HMAC root. */
export function isPlaceholderSecret(secret: string): boolean {
  return /^change-me/i.test(secret) || secret.includes('REPLACE_ME') || /^ci-only-/i.test(secret);
}

/** Example/CI service credentials (.env.example, ci.yml) that must never reach production. */
const EXAMPLE_ACCESS_KEYS = ['velto', 'velto-ci', 'minioadmin'];
const EXAMPLE_SECRETS = ['velto12345', 'velto-ci-secret', 'minioadmin'];
const EXAMPLE_URL_PASSWORDS = ['velto_app', 'velto_system', 'velto'];

export function isExampleS3Credential(value: string, kind: 'access' | 'secret'): boolean {
  return (kind === 'access' ? EXAMPLE_ACCESS_KEYS : EXAMPLE_SECRETS).includes(value);
}

export function hasExampleUrlPassword(url: string): boolean {
  try {
    return EXAMPLE_URL_PASSWORDS.includes(decodeURIComponent(new URL(url).password));
  } catch {
    return false;
  }
}

export function hasUrlPassword(url: string): boolean {
  try {
    return new URL(url).password !== '';
  } catch {
    return false;
  }
}
