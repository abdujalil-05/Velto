export const TELEGRAM_TEXT_MAX = 1024;
export const TELEGRAM_VALUE_MAX = 80;

// C0/C1 control chars except \n, Unicode line/paragraph separators, zero-width and bidi controls.
const CONTROL = new RegExp(
  '[' + [
    '\\u0000-\\u0009', '\\u000B-\\u001F', '\\u007F-\\u009F', '\\u2028\\u2029',
    '\\u200B-\\u200F', '\\u202A-\\u202E', '\\u2066-\\u2069', '\\uFEFF',
  ].join('') + ']',
  'g',
);

/** Plain-text sanitizer: strips control chars (keeps \n) and normalizes CR. */
export function stripControl(s: string): string {
  return s.replace(/\r\n?/g, '\n').replace(CONTROL, '');
}

/** One interpolated catalog value: no control chars/newlines, collapsed whitespace, clipped to `max` code points. */
export function safeValue(s: string | null | undefined, max = TELEGRAM_VALUE_MAX): string {
  const flat = stripControl(s ?? '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : flat;
}

/** Final Telegram body (plain text, no parse_mode): sanitized and hard-capped. */
export function renderTelegramText(title: string, message: string, max = TELEGRAM_TEXT_MAX): string {
  const chars = Array.from(stripControl(`${title}\n${message}`));
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}
