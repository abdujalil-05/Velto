const TELEGRAM_API = 'https://api.telegram.org';

export type TelegramSendResult =
  | { ok: true }
  | { ok: false; retryable: boolean; error: string };

/**
 * One Telegram sendMessage call with an HTTP status check. The returned `error` is a short code (never the
 * request URL, bot token or message body): fetch errors can embed the URL, so only name/cause code is kept.
 */
export async function sendTelegramMessage(token: string, chatId: bigint, text: string, timeoutMs: number): Promise<TelegramSendResult> {
  let res: Response;
  try {
    res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId.toString(), text }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const cause = e instanceof Error ? (e.cause as { code?: unknown } | undefined) : undefined;
    const code = typeof cause?.code === 'string' ? `:${cause.code.slice(0, 40)}` : '';
    return { ok: false, retryable: true, error: `NETWORK:${e instanceof Error ? e.name : 'error'}${code}` };
  }
  if (res.ok) return { ok: true };
  void res.body?.cancel().catch(() => undefined);
  return { ok: false, retryable: res.status === 429 || res.status >= 500, error: `HTTP_${res.status}` };
}
