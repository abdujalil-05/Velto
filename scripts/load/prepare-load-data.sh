#!/usr/bin/env bash
# Prepares velto_load (ONLY) for the API load run (ADR-053):
#  1. adds LOAD_CLONES extra OWNER users (own phone each, same password hash as the seeded
#     load owner) so every virtual user is a distinct userId — the API throttler is per userId,
#     120 req/min, hardcoded (app.module.ts), with no env override.
#  2. writes fixtures.json (ids only: warehouse, customers, products+packagings, user phones).
# Idempotent. Refuses any database but velto_load. Superuser only for these two steps (docker bootstrap).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
URL="${LOAD_PG_URL:-postgresql://velto:velto@localhost:5433/velto_load}"
OUT="${1:-$HERE/fixtures.json}"
CLONES="${LOAD_CLONES:-70}"
AGENT_CLONES="${LOAD_AGENT_CLONES:-30}"
case "$URL" in */velto_load|*/velto_load\?*) ;; *) echo "refusing: not velto_load" >&2; exit 1;; esac
# Template = the seeded load-tenant user of each role (the seeded phones also exist in 2 leftover
# verification tenants, so login-by-phone is ambiguous for them; the clones have unique phones).
psql "$URL" -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$
DECLARE r record; g int; cid uuid; nid uuid; tu uuid; trole uuid; thash text;
BEGIN
  SELECT c."id" INTO cid FROM "Company" c JOIN "Tenant" t ON t."id" = c."tenantId" WHERE t."slug" = 'load';
  PERFORM set_config('app.current_company_id', cid::text, true);
  FOR r IN SELECT * FROM (VALUES ('OWNER', '8', $CLONES), ('SALES_AGENT', '7', $AGENT_CLONES), ('CASHIER', '6', 2)) v(role, pfx, n) LOOP
    FOR g IN 1..r.n LOOP
      IF EXISTS (SELECT 1 FROM "User" WHERE "phone" = '+99899' || r.pfx || lpad(g::text, 6, '0')) THEN CONTINUE; END IF;
      SELECT u."id", ur."roleId", u."passwordHash" INTO tu, trole, thash
        FROM "User" u JOIN "UserRole" ur ON ur."userId" = u."id" JOIN "Role" ro ON ro."id" = ur."roleId"
        WHERE u."companyId" = cid AND ro."code" = r.role AND u."firstName" <> 'LoadClone' ORDER BY u."phone" LIMIT 1;
      nid := gen_random_uuid();
      INSERT INTO "User" ("id","companyId","firstName","lastName","phone","passwordHash","isActive","createdAt","updatedAt")
      VALUES (nid, cid, 'LoadClone', g::text, '+99899' || r.pfx || lpad(g::text, 6, '0'), thash, true, now(), now());
      INSERT INTO "UserRole" ("userId","roleId","createdAt") VALUES (nid, trole, now());
    END LOOP;
  END LOOP;
END \$\$;
SQL
psql "$URL" -At -v ON_ERROR_STOP=1 > "$OUT" <<'SQL'
WITH co AS (SELECT c."id" AS "companyId" FROM "Company" c JOIN "Tenant" t ON t."id" = c."tenantId" WHERE t."slug" = 'load'),
wh AS (SELECT s."warehouseId" FROM "StockLevel" s JOIN "Warehouse" w ON w."id" = s."warehouseId" WHERE w."companyId" = (SELECT "companyId" FROM co) GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 1)
SELECT json_build_object(
  'warehouseId', (SELECT "warehouseId" FROM wh),
  'customers', (SELECT json_agg(c."id") FROM (SELECT "id" FROM "Customer" WHERE "companyId" = (SELECT "companyId" FROM co) AND "isBlocked" IS NOT TRUE ORDER BY "code" LIMIT 300) c),
  'products', (SELECT json_agg(json_build_object('p', p."productId", 'k', pk."id")) FROM (
      SELECT s."productId" FROM "StockLevel" s WHERE s."warehouseId" = (SELECT "warehouseId" FROM wh) AND s."onHand" - s."reserved" > 600 ORDER BY s."productId" LIMIT 300) p
      JOIN LATERAL (SELECT "id" FROM "ProductPackaging" k WHERE k."productId" = p."productId" ORDER BY "isDefault" DESC, "qtyInBaseUnit" LIMIT 1) pk ON true),
  'owners', (SELECT json_agg(u."phone" ORDER BY u."phone") FROM "User" u WHERE u."phone" LIKE '+998998%'),
  'agents', (SELECT json_agg(u."phone" ORDER BY u."phone") FROM "User" u WHERE u."phone" LIKE '+998997%'),
  'cashiers', (SELECT json_agg(u."phone" ORDER BY u."phone") FROM "User" u WHERE u."phone" LIKE '+998996%')
);
SQL
echo "fixtures -> $OUT ($(wc -c < "$OUT") bytes)"
