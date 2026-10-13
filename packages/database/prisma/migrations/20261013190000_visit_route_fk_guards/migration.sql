-- Defense in depth: cross-tenant FK guards for the field tables that
-- 20260808120000_tenant_scoped_keys_and_fk_guards and
-- 20260810170000_couriers_replace_suppliers did not cover.
--
--   "Visit"."agentId"    -> "User"
--   "Visit"."outletId"   -> "Outlet"
--   "Route"."agentId"    -> "User"   (courierId already guarded)
--   "RouteRun"."routeId" -> "Route"
--
-- ("RouteStop" is already guarded by routestop_route_outlet_same_company.)
--
-- A plain FK only proves the target id exists; RLS does not catch a
-- company-A row naming a company-B parent because the written row carries the
-- correct companyId. These triggers reuse the existing
-- velto_assert_child_company_matches_parent() and fire for every writer,
-- including BYPASSRLS `velto_system`. Additive and backward-compatible.

-- Pre-check: existing rows must already satisfy the invariant. Fail loudly
-- (with counts) rather than install a trigger the data already violates.
DO $$
DECLARE
  visit_agent    bigint;
  visit_outlet   bigint;
  route_agent    bigint;
  routerun_route bigint;
BEGIN
  SELECT count(*) INTO visit_agent
    FROM "Visit" v LEFT JOIN "User" p ON p."id" = v."agentId"
   WHERE p."companyId" IS DISTINCT FROM v."companyId";
  SELECT count(*) INTO visit_outlet
    FROM "Visit" v LEFT JOIN "Outlet" p ON p."id" = v."outletId"
   WHERE p."companyId" IS DISTINCT FROM v."companyId";
  SELECT count(*) INTO route_agent
    FROM "Route" r LEFT JOIN "User" p ON p."id" = r."agentId"
   WHERE r."agentId" IS NOT NULL AND p."companyId" IS DISTINCT FROM r."companyId";
  SELECT count(*) INTO routerun_route
    FROM "RouteRun" x LEFT JOIN "Route" p ON p."id" = x."routeId"
   WHERE p."companyId" IS DISTINCT FROM x."companyId";

  IF visit_agent + visit_outlet + route_agent + routerun_route > 0 THEN
    RAISE EXCEPTION
      'cross-tenant rows exist, fix data before applying: Visit.agentId=%, Visit.outletId=%, Route.agentId=%, RouteRun.routeId=%',
      visit_agent, visit_outlet, route_agent, routerun_route
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE TRIGGER visit_agent_same_company
  BEFORE INSERT OR UPDATE ON "Visit"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('User', 'agentId');

CREATE TRIGGER visit_outlet_same_company
  BEFORE INSERT OR UPDATE ON "Visit"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('Outlet', 'outletId');

CREATE TRIGGER route_agent_same_company
  BEFORE INSERT OR UPDATE ON "Route"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('User', 'agentId');

CREATE TRIGGER routerun_route_same_company
  BEFORE INSERT OR UPDATE ON "RouteRun"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('Route', 'routeId');
