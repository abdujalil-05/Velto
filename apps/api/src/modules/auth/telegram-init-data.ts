import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TelegramUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

/**
 * Verifies a Telegram Mini App `initData` string per Telegram's documented
 * algorithm (SEC: "Telegram initData har so'rovda tekshiriladi"):
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 *   secret_key = HMAC_SHA256("WebAppData", bot_token)
 *   data_check_string = all fields except `hash`, "key=value" sorted by key, joined with "\n"
 *   verified iff HMAC_SHA256(secret_key, data_check_string) === hash
 */
export function verifyTelegramInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds: number,
): { user: TelegramUser; hash: string } {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) {
    throw new Error('initData missing hash');
  }
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const HEX64 = /^[0-9a-f]{64}$/;
  if (
    !HEX64.test(hash) ||
    !timingSafeEqual(Buffer.from(computedHash, 'hex'), Buffer.from(hash, 'hex'))
  ) {
    throw new Error('initData signature mismatch');
  }

  const authDate = Number(params.get('auth_date'));
  const ageSeconds = Date.now() / 1000 - authDate;
  // Future auth_date beyond 60 s clock-skew tolerance is treated like an expired one.
  if (!authDate || ageSeconds > maxAgeSeconds || ageSeconds < -60) {
    throw new Error('initData expired');
  }

  const userJson = params.get('user');
  if (!userJson) {
    throw new Error('initData missing user');
  }
  return { user: JSON.parse(userJson) as TelegramUser, hash };
}
