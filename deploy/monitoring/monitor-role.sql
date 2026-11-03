-- Run ONCE as superuser on the pilot DB. Read-only monitor role: NO app data columns, only status/timestamps.
-- BYPASSRLS is required because tenant tables have FORCE RLS (otherwise the role sees 0 rows).
-- Counts only: the monitor never selects row contents. Set the password on the server (\password), never in git.
CREATE ROLE velto_monitor LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS CONNECTION LIMIT 2;
ALTER ROLE velto_monitor SET default_transaction_read_only = on;
ALTER ROLE velto_monitor SET statement_timeout = '5s';
GRANT CONNECT ON DATABASE velto TO velto_monitor;  -- adjust DB name to the real pilot DB
GRANT USAGE ON SCHEMA public TO velto_monitor;
-- Column-level SELECT only: status/timestamps/attemptCount/type + id (id is used ONLY in memory to test "does the BullMQ job key exist", never printed).
-- NOT granted: companyId (the monitor cannot even attribute a row to a tenant), fileUrl, errorLog, payload, recipient/body/telegramLastError, any finance table.
-- BYPASSRLS is therefore only reachable through these columns = status counts and uuids.
GRANT SELECT (id, status, "updatedAt", "createdAt", "attemptCount") ON "ImportJob" TO velto_monitor;
GRANT SELECT (id, status, type, "updatedAt", "createdAt") ON "ExportJob" TO velto_monitor;
GRANT SELECT (id, "telegramStatus", "telegramNextAttemptAt", "telegramClaimedAt", "updatedAt", "createdAt") ON "Notification" TO velto_monitor;
-- Already-provisioned pilot DB: re-running this whole file fails on CREATE ROLE; apply only the three GRANT lines above (idempotent, additive).
-- Connection count WITHOUT pg_monitor/pg_read_all_stats: a SECURITY DEFINER function owned by a NOLOGIN role with NO extra privileges.
-- count(*) over pg_stat_activity works for any role (rows of other users are listed, only their query/details are masked as
-- '<insufficient privilege>'). It returns ONE integer (no query text, no per-tenant/per-user data).
CREATE ROLE velto_monitor_fn NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE SCHEMA velto_monitor AUTHORIZATION velto_monitor_fn;
REVOKE ALL ON SCHEMA velto_monitor FROM PUBLIC;
CREATE FUNCTION velto_monitor.conn_count() RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$ SELECT count(*)::integer FROM pg_catalog.pg_stat_activity WHERE datname = pg_catalog.current_database() $$;
ALTER FUNCTION velto_monitor.conn_count() OWNER TO velto_monitor_fn;
REVOKE EXECUTE ON FUNCTION velto_monitor.conn_count() FROM PUBLIC;
GRANT USAGE ON SCHEMA velto_monitor TO velto_monitor;
GRANT EXECUTE ON FUNCTION velto_monitor.conn_count() TO velto_monitor;
-- Rollback: REVOKE ALL ON "ImportJob","ExportJob","Notification" FROM velto_monitor; DROP SCHEMA velto_monitor CASCADE; DROP ROLE velto_monitor_fn; (no pg_* membership to revoke: velto_monitor_fn has none) DROP ROLE velto_monitor;
