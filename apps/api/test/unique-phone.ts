import { randomInt } from 'node:crypto';

/**
 * Test-only: a +998XXXXXXXXX phone drawn from the full 9-digit space (1e9).
 *
 * Why not 8M-wide random: tests never delete their users and every e2e file logs in with the same
 * password, while `AuthService.login` picks the first active user of that phone whose password
 * verifies (phone is unique per company only, TZ 15.2). With ~20k leftover users in a dev DB an
 * 8M space collides in a large share of runs, the login then returns a token for ANOTHER
 * tenant's user and the test sees a random 401/403/404/400.
 */
export const uniquePhone = (): string => `+998${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
