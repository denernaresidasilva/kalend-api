-- SELECT-only. Store output as root-private evidence BEFORE isolation, not in Git.
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
BEGIN READ ONLY;
DO $$ BEGIN IF current_database()<>'kalend_dev' THEN RAISE EXCEPTION 'WRONG_DATABASE'; END IF; END $$;
SELECT 'BEGIN;';
SELECT 'DO $$ BEGIN IF current_database()<>''kalend_dev'' OR to_regclass(''public."PaymentEvidence"'') IS NOT NULL THEN RAISE EXCEPTION ''SCHEMA_OR_TARGET_REVIEW_REQUIRED''; END IF; END $$;';
SELECT format('ALTER %s public.%I OWNER TO %I;',CASE c.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END,c.relname,c.relowner::regrole::text)
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S') ORDER BY c.oid;
SELECT format('ALTER TYPE public.%I OWNER TO %I;',t.typname,t.typowner::regrole::text) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typtype IN ('e','d');
SELECT format('ALTER FUNCTION public.%I(%s) OWNER TO %I;',p.proname,pg_get_function_identity_arguments(p.oid),p.proowner::regrole::text) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f';
SELECT format('ALTER DATABASE %I OWNER TO %I;',datname,datdba::regrole::text) FROM pg_database WHERE datname=current_database();
SELECT 'REVOKE SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public FROM kalend_dev_runtime;';
SELECT 'REVOKE USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public FROM kalend_dev_runtime;';
SELECT 'REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM kalend_dev_runtime;';
SELECT 'REVOKE USAGE ON SCHEMA public FROM kalend_dev_runtime;';
SELECT 'REVOKE CONNECT ON DATABASE kalend_dev FROM kalend_dev_runtime;';
SELECT 'ALTER DEFAULT PRIVILEGES FOR ROLE kalend_dev_migrator IN SCHEMA public REVOKE SELECT,INSERT,UPDATE,DELETE ON TABLES FROM kalend_dev_runtime;';
SELECT 'ALTER DEFAULT PRIVILEGES FOR ROLE kalend_dev_migrator IN SCHEMA public REVOKE USAGE,SELECT ON SEQUENCES FROM kalend_dev_runtime;';
SELECT 'ALTER DEFAULT PRIVILEGES FOR ROLE kalend_dev_migrator IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM kalend_dev_runtime;';
SELECT 'DROP ROLE kalend_dev_runtime,kalend_dev_migrator;';
SELECT 'COMMIT;';
ROLLBACK;
