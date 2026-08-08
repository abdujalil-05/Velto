-- "Bir vaqtda bitta ochiq smena" (9.2 "Smena ochish") is currently only
-- enforced by CashSessionsService.open()'s findFirst-then-create check —
-- two concurrent POST /cash-sessions/open calls (double-submit, or a retry
-- after a slow response) can both see no open session and both insert one.
-- A partial unique index (uniqueness only among currently-open rows) closes
-- that race at the DB level, matching the pattern in
-- prisma/migrations/*_soft_delete_partial_unique — Prisma's schema DSL has
-- no way to express `WHERE "closedAt" IS NULL`, hence hand-written SQL here.
CREATE UNIQUE INDEX "CashSession_userId_open_key"
  ON "CashSession" ("userId")
  WHERE "closedAt" IS NULL;
