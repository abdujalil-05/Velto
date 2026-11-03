/** Report screens aggregate in the DB but can exceed the 5 s default under load; bounded so a slow query cannot pin a pool connection. */
export const REPORT_TX_OPTIONS = { timeout: 15_000, maxWait: 5_000 };
