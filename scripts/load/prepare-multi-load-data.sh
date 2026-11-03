#!/usr/bin/env bash
# Multi-tenant fixtures for velto_load ONLY: bash prepare-multi-load-data.sh [out.json] slug1 slug2 ...
# Per tenant adds unique-phone clone users (seed-load phones repeat across tenants => login-by-phone
# is ambiguous): +998 8 <k> <role 1=OWNER 2=AGENT 3=CASHIER> <6-digit n>, then writes
# {"tenants":[fixtures per tenant]} (ids/phones only). Idempotent. Refuses any DB but velto_load.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
URL="${LOAD_PG_URL:-postgresql://velto:velto@localhost:5433/velto_load}"
OUT="$1"; shift
OWNERS="${LOAD_CLONES:-40}"; AGENTS="${LOAD_AGENT_CLONES:-12}"
case "$URL" in */velto_load|*/velto_load\?*) ;; *) echo "refusing: not velto_load" >&2; exit 1;; esac
K=0; PARTS=()
for SLUG in "$@"; do
K=$((K+1))
psql "$URL" -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$
DECLARE r record; g int; cid uuid; nid uuid; tu uuid; trole uuid; thash text; ph text;
BEGIN
  SELECT c."id" INTO cid FROM "Company" c JOIN "Tenant" t ON t."id" = c."tenantId" WHERE t."slug" = '$SLUG';
  PERFORM set_config('app.current_company_id', cid::text, true);
  FOR r IN SELECT * FROM (VALUES ('OWNER', '1', $OWNERS), ('SALES_AGENT', '2', $AGENTS), ('CASHIER', '3', 2)) v(role, pfx, n) LOOP
    FOR g IN 1..r.n LOOP
      ph := '+9988$K' || r.pfx || lpad(g::text, 6, '0');
      IF EXISTS (SELECT 1 FROM "User" WHERE "phone" = ph) THEN CONTINUE; END IF;
      SELECT u."id", ur."roleId", u."passwordHash" INTO tu, trole, thash
        FROM "User" u JOIN "UserRole" ur ON ur."userId" = u."id" JOIN "Role" ro ON ro."id" = ur."roleId"
        WHERE u."companyId" = cid AND ro."code" = r.role AND u."firstName" <> 'LoadClone' ORDER BY u."phone" LIMIT 1;
      nid := gen_random_uuid();
      INSERT INTO "User" ("id","companyId","firstName","lastName","phone","passwordHash","isActive","createdAt","updatedAt")
      VALUES (nid, cid, 'LoadClone', g::text, ph, thash, true, now(), now());
      INSERT INTO "UserRole" ("userId","roleId","createdAt") VALUES (nid, trole, now());
    END LOOP;
  END LOOP;
END \$\$;
SQL
PARTS+=("$(psql "$URL" -At -v ON_ERROR_STOP=1 <<SQL
WITH co AS (SELECT c."id" AS "companyId" FROM "Company" c JOIN "Tenant" t ON t."id" = c."tenantId" WHERE t."slug" = '$SLUG'),
wh AS (SELECT s."warehouseId" FROM "StockLevel" s JOIN "Warehouse" w ON w."id" = s."warehouseId" WHERE w."companyId" = (SELECT "companyId" FROM co) GROUP BY 1 ORDER BY count(*) FILTER (WHERE s."onHand" - s."reserved" > 200) DESC, 1 LIMIT 1)
SELECT json_build_object(
  'slug', '$SLUG',
  'warehouseId', (SELECT "warehouseId" FROM wh),
  'customers', (SELECT json_agg(c."id") FROM (SELECT "id" FROM "Customer" WHERE "companyId" = (SELECT "companyId" FROM co) AND "isBlocked" IS NOT TRUE ORDER BY "code" LIMIT 300) c),
  'products', (SELECT json_agg(json_build_object('p', p."productId", 'k', pk."id")) FROM (
      SELECT s."productId" FROM "StockLevel" s WHERE s."warehouseId" = (SELECT "warehouseId" FROM wh) AND s."onHand" - s."reserved" > 200 ORDER BY s."productId" LIMIT 300) p
      JOIN LATERAL (SELECT "id" FROM "ProductPackaging" k WHERE k."productId" = p."productId" ORDER BY "isDefault" DESC, "qtyInBaseUnit" LIMIT 1) pk ON true),
  'owners', (SELECT json_agg(u."phone" ORDER BY u."phone") FROM "User" u WHERE u."companyId" = (SELECT "companyId" FROM co) AND u."phone" LIKE '+9988${K}1%'),
  'agents', (SELECT json_agg(u."phone" ORDER BY u."phone") FROM "User" u WHERE u."companyId" = (SELECT "companyId" FROM co) AND u."phone" LIKE '+9988${K}2%'),
  'cashiers', (SELECT json_agg(u."phone" ORDER BY u."phone") FROM "User" u WHERE u."companyId" = (SELECT "companyId" FROM co) AND u."phone" LIKE '+9988${K}3%')
);
SQL
)")
done
{ printf '{"tenants":['; IFS=,; printf '%s' "${PARTS[*]}"; printf ']}\n'; } > "$OUT"
echo "fixtures -> $OUT ($(wc -c < "$OUT") bytes, $K tenants)"
