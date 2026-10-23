-- FUTURE ADMINISTRATIVE INTERVENTION ONLY. Never sourced by app/CI.
-- Execute on kalend_dev during an approved DEV maintenance window.
\set ON_ERROR_STOP on
BEGIN;
DO $$ BEGIN
 IF current_database()<>'kalend_dev' THEN RAISE EXCEPTION 'WRONG_DATABASE'; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ('kalend_dev_migrator','kalend_dev_runtime')) THEN
  RAISE EXCEPTION 'ROLE_ALREADY_EXISTS_REVIEW_REQUIRED';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname NOT IN ('public','information_schema')) THEN
  RAISE EXCEPTION 'UNREVIEWED_SCHEMA';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='public' AND nspowner::regrole::text<>'pg_database_owner') THEN
  RAISE EXCEPTION 'UNEXPECTED_PUBLIC_SCHEMA_OWNER';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_namespace n,LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.nspname='public' AND a.grantee=0 AND a.privilege_type='CREATE') THEN
  RAISE EXCEPTION 'UNREVIEWED_PUBLIC_CREATE';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typtype IN ('e','d') AND t.typowner::regrole::text<>'kalend') THEN
  RAISE EXCEPTION 'UNEXPECTED_TYPE_OWNER';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proowner::regrole::text<>'kalend') THEN
  RAISE EXCEPTION 'UNEXPECTED_FUNCTION_OWNER';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef) THEN
  RAISE EXCEPTION 'UNREVIEWED_SECURITY_DEFINER';
 END IF;
 IF (SELECT datdba::regrole::text FROM pg_database WHERE datname=current_database())<>'kalend' THEN
  RAISE EXCEPTION 'UNEXPECTED_DATABASE_OWNER';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S') AND c.relowner::regrole::text<>'kalend') THEN
  RAISE EXCEPTION 'UNEXPECTED_OBJECT_OWNER';
 END IF;
END $$;
CREATE ROLE kalend_dev_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 2;
CREATE ROLE kalend_dev_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 20;
-- No passwords: only the exact OS identities permitted by peer/HBA/ident may connect.
ALTER DATABASE kalend_dev OWNER TO kalend_dev_migrator;
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT c.relname,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S') LOOP
  EXECUTE format('ALTER %s public.%I OWNER TO kalend_dev_migrator', CASE r.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END,r.relname);
 END LOOP;
 FOR r IN SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typtype IN ('e','d') LOOP
  EXECUTE format('ALTER TYPE public.%I OWNER TO kalend_dev_migrator',r.typname);
 END LOOP;
 FOR r IN SELECT p.proname,pg_get_function_identity_arguments(p.oid) args FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f' LOOP
  EXECUTE format('ALTER FUNCTION public.%I(%s) OWNER TO kalend_dev_migrator',r.proname,r.args);
 END LOOP;
END $$;
GRANT CONNECT ON DATABASE kalend_dev TO kalend_dev_runtime;
GRANT USAGE ON SCHEMA public TO kalend_dev_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO kalend_dev_runtime;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO kalend_dev_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO kalend_dev_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE kalend_dev_migrator IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO kalend_dev_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE kalend_dev_migrator IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO kalend_dev_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE kalend_dev_migrator IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO kalend_dev_runtime;
COMMIT;
