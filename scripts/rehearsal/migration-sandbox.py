"""Runs ONLY inside the private namespace sandbox prepared by the local driver.
No remote connections. Raw errors/data remain in the private work directory.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time

BIN = '/pgroot/usr/lib/postgresql/16/bin/'
ENV = {'PATH': '/usr/bin:/bin', 'HOME': '/work', 'LD_LIBRARY_PATH': '/pgroot/usr/lib/x86_64-linux-gnu', 'PGTZ': 'UTC', 'TZ': 'UTC', 'LANG': 'C', 'DOTENV_CONFIG_PATH': '/dev/null', 'CHECKPOINT_DISABLE': '1', 'PRISMA_HIDE_UPDATE_MESSAGE': '1', 'NO_COLOR': '1'}
ROLE = 'kalend_rehearsal_owner'
BASE = ['-h', '/work', '-p', '55441', '-w', '-U', ROLE]
MIGRATION = Path('/work/migration.sql').read_text()
MANIFEST = json.loads(Path('/work/snapshot-manifest.private.json').read_text())
RESULT = {'scope': 'LOCAL_PRIVATE_NETWORK_NAMESPACE_ONLY', 'source_dump_sha256': hashlib.sha256(Path('/work/kalend_dev.dump').read_bytes()).hexdigest(), 'sql_role_superuser': False, 'tests': {}}
assert Path('/work/ISOLATED_REHEARSAL').exists()
assert not Path('/home/guest').exists() and not Path('/var/run/postgresql').exists()
assert len(Path('/proc/net/route').read_text().splitlines()) == 1


def run(name, args, content=None, expect=0, options=None):
    r = subprocess.run([BIN + name, *args], input=content, capture_output=True, text=True, env={**ENV, **(options or {})}, timeout=60)
    if r.returncode != expect:
        Path('/work/failed-command.private.log').write_text(r.stderr + '\n' + r.stdout)
        raise RuntimeError(name + '_FAILED_PRIVATE_LOG')
    return r


def sql(db, text, role=ROLE):
    args = [*BASE, '-d', db, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-c', text]
    args[args.index('-U') + 1] = role
    return run('psql', args).stdout.strip()


def proc(db, text, options=None):
    p = subprocess.Popen([BIN + 'psql', *BASE, '-d', db, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env={**ENV, **(options or {})})
    p.stdin.write(text + '\n'); p.stdin.flush()
    return p


def ident(name):
    return '"' + name.replace('"', '""') + '"'


def fingerprints(db, ledger_original_only=False):
    out = {}
    for table in MANIFEST['tables']:
        restriction = " WHERE t.migration_name <> '20261017090000_subscription_entitlement_evidence'" if ledger_original_only and table == '_prisma_migrations' else ''
        out[table] = json.loads(sql(db, "SELECT json_build_object('count',count(*),'fingerprint',md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text)),''))) FROM public." + ident(table) + ' t' + restriction))
    return out


def clone(name, template='kalend_rehearsal_legacy'):
    assert name.startswith('kalend_rehearsal_') and name not in ['kalend_dev', 'kalend']
    run('createdb', [*BASE, '-T', template, name])
    return name


def verify_finance(db):
    assert fingerprints(db, True) == MANIFEST['tables'], 'PREEXISTING_DATA_CHANGED'
    result = json.loads(sql(db, '''SELECT json_build_object(
      'evidence',(SELECT count(*) FROM "PaymentEvidence"),
      'applied',(SELECT count(*) FROM "PaymentEvidence" WHERE status='APPLIED'),
      'entitlements',(SELECT count(*) FROM "SubscriptionEntitlement"),
      'admin_grants',(SELECT count(*) FROM "SubscriptionEntitlement" WHERE origin='ADMIN_GRANT'),
      'subscriptions_with_right',(SELECT count(DISTINCT "subscriptionId") FROM "SubscriptionEntitlement"),
      'subscriptions_without_right',(SELECT count(*) FROM "Subscription" s WHERE NOT EXISTS (SELECT 1 FROM "SubscriptionEntitlement" e WHERE e."subscriptionId"=s.id)),
      'unproven_evidence',(SELECT count(*) FROM "PaymentEvidence" e JOIN "Payment" p ON p.id=e."paymentId" JOIN "Subscription" s ON s.id=e."subscriptionId" WHERE p.status<>'APPROVED' OR p."paidAt" IS NULL OR p."amountCents"<=p."refundedAmountCents" OR p."companyId"<>e."companyId" OR p."subscriptionId"<>e."subscriptionId" OR p."planId"<>s."planId"),
      'valid_period_coverage',(SELECT count(*) FROM "SubscriptionEntitlement" e JOIN "Subscription" s ON s.id=e."subscriptionId" WHERE kalend_subscription_period_covered(s.id,s."currentPeriodStart",s."currentPeriodEnd")),
      'tables',(SELECT count(*) FROM pg_tables WHERE schemaname='public'),
      'constraints',(SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public'),
      'invalid_constraints',(SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' AND NOT c.convalidated),
      'indexes',(SELECT count(*) FROM pg_indexes WHERE schemaname='public'),
      'invalid_indexes',(SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT i.indisvalid));'''))
    for key, expected in {'evidence': 1, 'applied': 1, 'entitlements': 1, 'admin_grants': 0, 'subscriptions_with_right': 1, 'subscriptions_without_right': 6, 'unproven_evidence': 0, 'valid_period_coverage': 1, 'tables': 29, 'invalid_constraints': 0, 'invalid_indexes': 0}.items():
        assert result[key] == expected, key
    return result


def apply_sql(db):
    start = time.monotonic()
    run('psql', [*BASE, '-d', db, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '/work/migration.sql'], options={'PGOPTIONS': '-c lock_timeout=2000 -c statement_timeout=15000'})
    return round((time.monotonic() - start) * 1000, 3)


def assert_rolled_back(db, ledger_original_only=False):
    assert sql(db, "SELECT to_regclass('public.\"PaymentEvidence\"') IS NULL AND to_regclass('public.\"SubscriptionEntitlement\"') IS NULL AND NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='EntitlementOrigin')") == 't'
    assert fingerprints(db, ledger_original_only) == MANIFEST['tables']
    functions = json.loads(sql(db, "SELECT json_agg(json_build_object('name',p.proname,'definition',pg_get_functiondef(p.oid)) ORDER BY p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'"))
    assert functions == MANIFEST['inventory']['functions'], 'FUNCTION_ROLLBACK_FAILED'
    assert sql(db, "SELECT count(*) FROM pg_trigger WHERE tgname='payment_evidence_scope_immutable'") == '0'


started = False
try:
    run('initdb', ['-D', '/work/cluster', '-U', 'kalend_rehearsal_bootstrap', '--auth-local=trust', '--auth-host=reject', '--no-locale', '-E', 'UTF8'])
    run('pg_ctl', ['-D', '/work/cluster', '-l', '/work/server.private.log', '-o', "-h '' -p 55441 -k /work", '-w', 'start']); started = True
    sql('postgres', 'CREATE ROLE kalend_rehearsal_owner LOGIN NOSUPERUSER CREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', 'kalend_rehearsal_bootstrap')
    sql('postgres', 'CREATE DATABASE kalend_rehearsal_legacy OWNER kalend_rehearsal_owner', 'kalend_rehearsal_bootstrap')
    sql('postgres', 'ALTER ROLE kalend_rehearsal_bootstrap NOLOGIN', 'kalend_rehearsal_bootstrap')
    assert sql('kalend_rehearsal_legacy', 'SELECT rolsuper FROM pg_roles WHERE rolname=current_user') == 'f'
    run('pg_restore', [*BASE, '-d', 'kalend_rehearsal_legacy', '--no-owner', '--no-acl', '--single-transaction', '--exit-on-error', '/work/kalend_dev.dump'])
    assert fingerprints('kalend_rehearsal_legacy') == MANIFEST['tables']
    RESULT['original_snapshot_restored_and_fingerprints_match'] = True
    # Actual migration engine, not a hand-written ledger row.
    db = clone('kalend_rehearsal_success')
    url = 'postgresql://' + ROLE + '@localhost:55441/' + db + '?host=%2Fwork'
    prisma = ['/node/bin/node', '/app/node_modules/prisma/build/index.js']
    env = {**ENV, 'DATABASE_URL': url}
    def prisma_run(command):
        t = time.monotonic()
        p = subprocess.run([*prisma, *command, '--config', '/work/prisma.config.mjs'], env=env, text=True, capture_output=True, timeout=90)
        with open('/work/prisma.private.log', 'a') as f: f.write(p.stdout + p.stderr)
        assert p.returncode == 0, 'PRISMA_COMMAND_FAILED_PRIVATE_LOG'
        return round((time.monotonic()-t)*1000, 3)
    RESULT['prisma_validate_ms'] = prisma_run(['validate'])
    RESULT['migration_engine_wall_ms'] = prisma_run(['migrate', 'deploy'])
    RESULT['finance'] = verify_finance(db)
    checksum = hashlib.sha256(MIGRATION.encode()).hexdigest()
    assert sql(db, "SELECT count(*) FROM _prisma_migrations WHERE migration_name='20261017090000_subscription_entitlement_evidence' AND finished_at IS NOT NULL AND checksum='"+checksum+"'") == '1'
    RESULT['tests']['prisma_ledger_exactly_one_completed_migration'] = True
    before = sql(db, 'SELECT md5(string_agg(to_jsonb(e)::text,\'\' ORDER BY e.id)) FROM "SubscriptionEntitlement" e')
    RESULT['prisma_second_deploy_ms'] = prisma_run(['migrate', 'deploy'])
    assert before == sql(db, 'SELECT md5(string_agg(to_jsonb(e)::text,\'\' ORDER BY e.id)) FROM "SubscriptionEntitlement" e')
    assert verify_finance(db) == RESULT['finance']
    RESULT['tests']['prisma_second_deploy_no_changes'] = True
    # Real lock waits with independent connections; failures must roll back ALL DDL/data.
    timeouts = []
    for label, opts, code in [('lock_timeout', '-c lock_timeout=200 -c statement_timeout=5000', '55P03'), ('statement_timeout', '-c lock_timeout=0 -c statement_timeout=200', '57014')]:
        target = clone('kalend_rehearsal_' + label)
        holder = proc(target, "BEGIN; LOCK TABLE \"Payment\" IN ACCESS EXCLUSIVE MODE; SELECT pg_backend_pid();")
        holder_pid = int(holder.stdout.readline())
        t = time.monotonic()
        p = run('psql', [*BASE, '-d', target, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-f', '/work/migration.sql'], expect=3, options={'PGOPTIONS': opts})
        elapsed = round((time.monotonic()-t)*1000, 3)
        assert code in p.stderr
        holder.stdin.write('ROLLBACK;\n'); holder.stdin.close(); assert holder.wait(timeout=5) == 0
        assert_rolled_back(target)
        retry_ms = apply_sql(target); verify_finance(target)
        timeouts.append({'scenario': label, 'sqlstate': code, 'wall_ms': elapsed, 'holder_pid': holder_pid, 'complete_rollback_verified': True, 'retry_success_ms': retry_ms})
    RESULT['timeouts'] = timeouts
    # Exercise the REAL Prisma failed-ledger path, not just SQL transaction rollback.
    engine_db = clone('kalend_rehearsal_engine_failure')
    holder = proc(engine_db, 'BEGIN; LOCK TABLE "Payment" IN ACCESS EXCLUSIVE MODE; SELECT pg_backend_pid();')
    holder_pid = int(holder.stdout.readline())
    holder.stdin.write('SELECT pg_sleep(3); ROLLBACK;\n'); holder.stdin.close()
    engine_url = 'postgresql://' + ROLE + '@localhost:55441/' + engine_db + '?host=%2Fwork&options=-c%20lock_timeout%3D200%20-c%20statement_timeout%3D5000'
    engine_env = {**ENV, 'DATABASE_URL': engine_url}
    server_log_offset = Path('/work/server.private.log').stat().st_size
    failure = subprocess.run([*prisma, 'migrate', 'deploy', '--config', '/work/prisma.config.mjs'], env=engine_env, text=True, capture_output=True, timeout=30)
    Path('/work/prisma-failure.private.log').write_text(failure.stdout + failure.stderr)
    new_server_log = Path('/work/server.private.log').read_bytes()[server_log_offset:].decode(errors='replace')
    assert failure.returncode != 0 and 'canceling statement due to lock timeout' in new_server_log, 'ENGINE_TIMEOUT_NOT_REPRODUCED'
    RESULT['prisma_failure_diagnostic'] = 'lock timeout confirmed in private server log; CLI reported transaction-aborted symptom; failed ledger inspected before resolve'
    assert holder.wait(timeout=5) == 0
    assert_rolled_back(engine_db, True)
    assert sql(engine_db, "SELECT count(*) FROM _prisma_migrations WHERE migration_name='20261017090000_subscription_entitlement_evidence' AND finished_at IS NULL AND rolled_back_at IS NULL") == '1'
    blocked = subprocess.run([*prisma, 'migrate', 'deploy', '--config', '/work/prisma.config.mjs'], env=engine_env, text=True, capture_output=True, timeout=30)
    assert blocked.returncode != 0 and 'P3009' in blocked.stdout + blocked.stderr
    resolved = subprocess.run([*prisma, 'migrate', 'resolve', '--rolled-back', '20261017090000_subscription_entitlement_evidence', '--config', '/work/prisma.config.mjs'], env=engine_env, text=True, capture_output=True, timeout=30)
    assert resolved.returncode == 0
    recovered = subprocess.run([*prisma, 'migrate', 'deploy', '--config', '/work/prisma.config.mjs'], env=engine_env, text=True, capture_output=True, timeout=30)
    assert recovered.returncode == 0
    verify_finance(engine_db)
    RESULT['tests']['prisma_failed_ledger_blocks_retry_until_verified_rollback_and_resolve'] = True
    target = clone('kalend_rehearsal_cancel')
    body = MIGRATION.rsplit('COMMIT;', 1)[0]
    migrating = proc(target, "SELECT pg_backend_pid();\n"+body+"\nSELECT 'PRECOMMIT_READY'; SELECT pg_sleep(30); COMMIT;")
    migrating_pid = int(migrating.stdout.readline())
    assert migrating.stdout.readline().strip() == 'PRECOMMIT_READY'
    RESULT['migration_locks'] = json.loads(sql(target, "SELECT coalesce(json_agg(json_build_object('type',locktype,'mode',mode,'granted',granted,'relation',relation::regclass::text) ORDER BY relation,mode), '[]'::json) FROM pg_locks WHERE pid="+str(migrating_pid)+" AND locktype='relation'"))
    t = time.monotonic(); assert sql(target, 'SELECT count(*) FROM "Payment"') == '5'
    RESULT['read_during_precommit_wall_ms'] = round((time.monotonic()-t)*1000, 3)
    p = run('psql', [*BASE, '-d', target, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-c', 'BEGIN; SET LOCAL lock_timeout=\'200ms\'; UPDATE "Payment" SET "updatedAt"="updatedAt" WHERE false; ROLLBACK;'], expect=1)
    assert '55P03' in p.stderr
    RESULT['tests']['write_waits_while_existing_reads_continue'] = True
    assert sql(target, 'SELECT pg_cancel_backend('+str(migrating_pid)+')') == 't'
    migrating.stdin.close(); assert migrating.wait(timeout=5) != 0
    assert_rolled_back(target); RESULT['tests']['cancel_before_commit_rolls_back_all_ddl_and_financial_data'] = True
    RESULT['raw_sql_retry_wall_ms'] = apply_sql(target); verify_finance(target)
    RESULT['tests']['retry_after_cancel_succeeds'] = True
    # Raw SQL deliberately isn't idempotent; migration ledger is the supported replay guard.
    p = run('psql', [*BASE, '-d', target, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-f', '/work/migration.sql'], expect=3)
    assert '42710' in p.stderr; verify_finance(target)
    RESULT['tests']['raw_sql_replay_rejected_without_duplicate_rights'] = True
    qa = clone('kalend_rehearsal_qa', 'kalend_rehearsal_success')
    qa_url = 'postgresql://' + ROLE + '@localhost:55441/' + qa + '?host=%2Fwork'
    p = subprocess.run(['/node/bin/node', '/app/candidate-probe.mjs'], env={**ENV, 'DATABASE_URL': qa_url}, capture_output=True, text=True, timeout=90)
    Path('/work/candidate-probe.private.log').write_text(p.stdout + p.stderr)
    assert p.returncode == 0, 'CANDIDATE_PROBE_FAILED_PRIVATE_LOG'
    RESULT['candidate_api'] = json.loads(Path('/work/candidate-probe.sanitized.json').read_text())
    RESULT['postgres'] = run('postgres', ['--version']).stdout.strip()
    RESULT['migration_sha256'] = checksum
    RESULT['no_external_routes'] = True
    RESULT['source_legacy_copy_untouched'] = fingerprints('kalend_rehearsal_legacy') == MANIFEST['tables']
finally:
    if started: run('pg_ctl', ['-D', '/work/cluster', '-m', 'fast', '-w', 'stop'])
    RESULT['cluster_stopped'] = True
    Path('/work/rehearsal.sanitized.json').write_text(json.dumps(RESULT, indent=2)+'\n')
