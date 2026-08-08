-- The append-only guard added in 20260730161500_rls_and_audit_lock only
-- covers row-level UPDATE/DELETE. TRUNCATE fires statement-level triggers,
-- not row-level ones, so it silently bypassed that guard entirely (found
-- while wiping local dev data with `TRUNCATE ... CASCADE` as a superuser —
-- worth closing since `velto`/`velto_system` were both granted TRUNCATE via
-- "ALL PRIVILEGES" in provision-roles.sql).
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON "AuditLog"
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_audit_log_mutation();
