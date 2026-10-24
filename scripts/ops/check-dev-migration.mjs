import 'dotenv/config';
import pg from 'pg';
import { devMigrationUrl } from './dev-migration-target.mjs';

const client = new pg.Client({ connectionString: devMigrationUrl(process.env.DEV_MIGRATION_DATABASE_URL), connectionTimeoutMillis: 5000 });
try {
  await client.connect();
  await client.query('BEGIN READ ONLY');
  const { rows: [r] } = await client.query(`SELECT current_database() AS database, current_user AS role,
    rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls AS privileged,
    EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS memberships,
    EXISTS(SELECT 1 FROM pg_database WHERE datdba=r.oid AND datname<>'kalend_dev') AS other_database_owner
    FROM pg_roles r WHERE rolname=current_user`);
  if (!r || r.database !== 'kalend_dev' || r.role !== 'kalend_dev_migrator' || r.privileged || r.memberships || r.other_database_owner) {
    throw new Error('DEV migration SQL identity failed privilege checks');
  }
  await client.query('ROLLBACK');
  console.log('DEV migration target verified: kalend_dev / kalend_dev_migrator');
} catch {
  console.error('DEV migration preflight failed; no DDL executed. Check dedicated credentials and privileges.');
  process.exitCode = 1;
} finally { await client.end(); }
