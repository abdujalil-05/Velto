-- F-M01 (6.3): duplicate detection warns on name similarity, in addition to
-- exact INN/phone matches and outlet coordinate proximity. pg_trgm's
-- similarity() is the standard Postgres way to do fuzzy name matching
-- without pulling in an external search engine for MVP.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Trigram index so ORDER BY similarity(name, $1) DESC doesn't full-scan
-- Customer as the table grows.
CREATE INDEX "Customer_name_trgm_idx" ON "Customer" USING gin (name gin_trgm_ops);
