-- PROPOSAL ONLY: administrator reviews/applies to kalend_dev, never via application credentials.
-- Unix peer authentication: same-name dedicated OS account kalend_dev_audit.
-- No password, role membership, object ownership, pg_read_all_data or superuser.
BEGIN;
DO $$ BEGIN
  IF current_database() <> 'kalend_dev' THEN RAISE EXCEPTION 'WRONG_DATABASE'; END IF;
END $$;
CREATE ROLE kalend_dev_audit LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 2;
ALTER ROLE kalend_dev_audit SET default_transaction_read_only = on;
ALTER ROLE kalend_dev_audit SET statement_timeout = '30s';
ALTER ROLE kalend_dev_audit SET lock_timeout = '3s';
ALTER ROLE kalend_dev_audit SET idle_in_transaction_session_timeout = '15s';
ALTER ROLE kalend_dev_audit SET search_path = pg_catalog, public;
ALTER ROLE kalend_dev_audit SET row_security = off;
GRANT CONNECT ON DATABASE kalend_dev TO kalend_dev_audit;
GRANT USAGE ON SCHEMA public TO kalend_dev_audit;
GRANT SELECT ON TABLE public."Subscription", public."Payment", public._prisma_migrations TO kalend_dev_audit;
-- No grants on Company/User, credentials/provider tables, sequences or functions.
-- Verify PUBLIC privileges and SECURITY DEFINER functions before enabling the forced command.
-- default_transaction_read_only alone is not a security boundary; ACL + fixed command are required.

COMMIT;
