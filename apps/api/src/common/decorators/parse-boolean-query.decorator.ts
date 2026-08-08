import { Transform } from 'class-transformer';

/**
 * `@Type(() => Boolean)` on a query-string DTO field uses JS's `Boolean(x)`
 * coercion, which treats ANY non-empty string — including the literal text
 * "false" — as `true`. Use this instead for boolean query params.
 */
export function ParseBooleanQuery() {
  return Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  });
}
