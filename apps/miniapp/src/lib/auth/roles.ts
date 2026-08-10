// System role codes as seeded in packages/database/src/seed.ts. Only the two
// roles this app branches on are listed — everything else lands on the agent
// experience, which is the app's default.
export const ROLE_SALES_AGENT = 'SALES_AGENT';
export const ROLE_COURIER = 'COURIER';

/**
 * A courier is an ordinary User carrying the COURIER role (owner's decision —
 * reuses the agent Telegram login unchanged). The Mini App only switches to the
 * delivery screen for someone who is a courier and *not* also a sales agent:
 * a user holding both keeps the full agent experience, since it is the strict
 * superset (routes, orders, payments) and losing it would be a regression.
 */
export function isCourierOnly(roles: readonly string[] | undefined | null): boolean {
  if (!roles) return false;
  return roles.includes(ROLE_COURIER) && !roles.includes(ROLE_SALES_AGENT);
}
