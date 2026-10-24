"""Native local-only backup review. Never reads a private env or connects to real DBs.
Requires the explicitly bootstrapped ephemeral cluster metadata from this review.
All test and dump/restore connections must be NOSUPERUSER.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
from urllib.parse import urlparse

metadata = json.loads(Path('/tmp/kalend-admin-review-local-cluster.json').read_text())
data = Path(metadata['data'])
url = urlparse(metadata['url'])
source = url.path[1:]
if (url.hostname != '127.0.0.1' or url.username != 'kalend_audit'
        or not source.startswith('kalend_audit_ephemeral_') or data.parent != Path('/tmp')
        or not data.name.startswith('kalend-native-pg-') or data.resolve() != data
        or data.stat().st_uid != os.getuid()
        or (data / 'KALEND_AUDIT_EPHEMERAL').read_text() != source):
    raise SystemExit('ISOLATED_FIXTURE_REQUIRED')
binary = Path(metadata['bin'])
env = {**os.environ, 'PGTZ': 'UTC'}
for key in list(env):
    if key.startswith('PG') and key != 'PGTZ':
        del env[key]
base = ['-h', '127.0.0.1', '-p', str(metadata['port'])]


def run(name, args, expected=0):
    result = subprocess.run([str(binary / name), *args], env=env, text=True, capture_output=True)
    if result.returncode != expected:
        raise AssertionError(f'{name} unexpected exit {result.returncode}: {result.stderr}')
    return result


def sql(database, query, user='kalend_audit'):
    return run('psql', [*base, '-U', user, '-d', database, '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c', query]).stdout.strip()


assert sql(source, 'SHOW data_directory') == str(data)
assert sql(source, 'SELECT rolsuper FROM pg_roles WHERE rolname=current_user') == 'f'
root = Path(__file__).resolve().parents[2]
# Synthetic fixture setup by a NOSUPERUSER database owner, not a real migration.
run('psql', [*base, '-U', 'kalend_audit', '-d', source, '-X', '-v', 'ON_ERROR_STOP=1', '-f', str(root / 'prisma/migrations/20261017090000_subscription_entitlement_evidence/migration.sql')])
sql(source, '''CREATE ROLE kalend_backup_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO kalend_backup_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO kalend_backup_reader;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO kalend_backup_reader;
ALTER ROLE kalend_backup_reader SET default_transaction_read_only=on;
ALTER ROLE kalend_backup_reader SET row_security=off;''')
assert sql(source, 'SELECT rolsuper FROM pg_roles WHERE rolname=current_user', 'kalend_backup_reader') == 'f'
artifact = Path(tempfile.mkdtemp(prefix='kalend-backup-review-'))
os.chmod(artifact, 0o700)
# Earlier access test deliberately enabled RLS; dump must fail, not silently omit rows.
blocked = subprocess.run([str(binary / 'pg_dump'), *base, '-U', 'kalend_backup_reader', '-d', source, '-Fc', '-f', str(artifact / 'rejected.dump')], env=env, capture_output=True, text=True)
assert blocked.returncode != 0 and 'row-level security' in blocked.stderr
sql(source, '''ALTER TABLE public."Subscription" DISABLE ROW LEVEL SECURITY;
BEGIN;
INSERT INTO "Company"(id,name,slug,status,"updatedAt") VALUES ('00000000-0000-4000-8000-000000000001','Backup fixture','backup-fixture','ACTIVE',now());
INSERT INTO "Plan"(id,name,code,"monthlyPriceCents","updatedAt") VALUES ('00000000-0000-4000-8000-000000000002','Fixture','backup-plan',100,now());
INSERT INTO "Subscription"(id,"companyId","planId",status,gateway,"currentPeriodStart","currentPeriodEnd","updatedAt") VALUES ('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','ACTIVE','STRIPE',now(),now()+interval '1 month',now());
INSERT INTO "Payment"(id,"companyId","planId","subscriptionId",gateway,status,"amountCents","paidAt","periodStart","periodEnd","updatedAt") SELECT '00000000-0000-4000-8000-000000000004',"companyId","planId",id,'STRIPE','APPROVED',100,now(),"currentPeriodStart","currentPeriodEnd",now() FROM "Subscription";
INSERT INTO "SubscriptionEntitlement"(id,"subscriptionId",origin,"startsAt","endsAt") SELECT '00000000-0000-4000-8000-000000000005',"subscriptionId",'PAYMENT',"periodStart","periodEnd" FROM "Payment";
INSERT INTO "PaymentEvidence"("paymentId","companyId","subscriptionId","entitlementId","startsAt","endsAt") SELECT id,"companyId","subscriptionId",'00000000-0000-4000-8000-000000000005',"periodStart","periodEnd" FROM "Payment";
COMMIT;''')
archive = artifact / 'synthetic.dump'
run('pg_dump', [*base, '-U', 'kalend_backup_reader', '-d', source, '-Fc', '-f', str(archive)])
os.chmod(archive, 0o600)
target = source + '_restore'
run('createdb', [*base, '-U', 'kalend_audit', target])
assert sql(target, 'SELECT rolsuper FROM pg_roles WHERE rolname=current_user') == 'f'
run('pg_restore', [*base, '-U', 'kalend_audit', '-d', target, '--no-owner', '--no-acl', '--single-transaction', '--exit-on-error', str(archive)])
# Compare every public table, including financial records and both evidence tables.
tables = sql(source, "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename").splitlines()
for table in tables:
    quoted = '"' + table.replace('"', '""') + '"'
    query = f"SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text FROM public.{quoted} t"
    assert sql(source, query) == sql(target, query), table
for table in ['Payment', 'Subscription', 'PaymentEvidence', 'SubscriptionEntitlement']:
    assert sql(target, f'SELECT count(*) FROM public."{table}"') == '1'
assert sql(target, "SELECT count(*) FROM pg_constraint WHERE connamespace='public'::regnamespace") == sql(source, "SELECT count(*) FROM pg_constraint WHERE connamespace='public'::regnamespace")
print(json.dumps({'source_role_superuser': False, 'dump_role_superuser': False, 'restore_role_superuser': False,
    'dump_refuses_rls_omission': True, 'public_tables_equal': len(tables), 'financial_and_evidence_rows_restored': True,
    'constraints_equal': True, 'archive_sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
    'scope': 'SYNTHETIC_LOCAL_ONLY', 'artifact': str(artifact)}, indent=2))
