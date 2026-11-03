export const DELIVERED_QTY_CHECK = 'SalesOrderLine_deliveredQty_range_check';

const CHECK_VIOLATION_SQLSTATE = '23514';

function haystack(err: object): string {
  const e = err as { message?: unknown; meta?: unknown; cause?: unknown };
  const parts: string[] = [];
  if (typeof e.message === 'string') parts.push(e.message);
  if (e.meta !== undefined) {
    try {
      parts.push(JSON.stringify(e.meta));
    } catch {
      /* non-serialisable meta: ignore */
    }
  }
  if (e.cause && typeof e.cause === 'object') {
    const cause = (e.cause as { message?: unknown }).message;
    if (typeof cause === 'string') parts.push(cause);
  }
  return parts.join('\n');
}

/**
 * True only for a violation of SalesOrderLine_deliveredQty_range_check.
 * Accepts the constraint name anywhere Prisma may surface it (message,
 * `meta`, driver `cause`), or SQLSTATE 23514 (on `code`/`meta.code`/in the
 * text) together with a check-constraint mention of `deliveredQty`. Any other
 * error — another constraint, a unique violation, a bare 23514 on a different
 * column — returns false so it propagates unchanged.
 */
export function isDeliveredQtyCheckViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const text = haystack(err);
  if (text.includes(DELIVERED_QTY_CHECK)) return true;

  const e = err as { code?: unknown; meta?: unknown };
  const metaCode =
    e.meta && typeof e.meta === 'object' ? (e.meta as { code?: unknown }).code : undefined;
  const isCheckViolation =
    e.code === CHECK_VIOLATION_SQLSTATE ||
    metaCode === CHECK_VIOLATION_SQLSTATE ||
    new RegExp(`\\b${CHECK_VIOLATION_SQLSTATE}\\b`).test(text);
  return isCheckViolation && /check constraint/i.test(text) && text.includes('SalesOrderLine') && text.includes('deliveredQty');
}
