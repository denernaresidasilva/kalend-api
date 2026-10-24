-- PHASE C, administrator only, kalend_dev. No OS login or CI credential is created.
BEGIN;
DO $$ BEGIN
  IF current_database() <> 'kalend_dev' THEN RAISE EXCEPTION 'WRONG_DATABASE'; END IF;
END $$;
CREATE ROLE kalend_dev_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 2;
ALTER ROLE kalend_dev_backup SET default_transaction_read_only = on;
ALTER ROLE kalend_dev_backup SET row_security = off;
ALTER ROLE kalend_dev_backup SET search_path = pg_catalog, public;
ALTER ROLE kalend_dev_backup SET lock_timeout = '3s';
GRANT CONNECT ON DATABASE kalend_dev TO kalend_dev_backup;
GRANT USAGE ON SCHEMA public TO kalend_dev_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO kalend_dev_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO kalend_dev_backup;
-- No global pg_read_all_data, bypassrls, superuser or default privileges for other owners.
-- Stop if non-public user schemas, large objects, foreign tables or RLS need more grants.
COMMIT;
