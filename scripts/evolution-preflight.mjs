import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { evolutionPreflight } from '../dist/communication/evolution-preflight.js';

// Explicit snapshot mode or DEV-only, read-only database mode. Never mutate data/schema.
let client;
try {
  const args = process.argv.slice(2);
  const snapshotIndex = args.indexOf('--snapshot');
  const environmentIndex = args.indexOf('--environment');
  const environment = args[environmentIndex + 1];
  if (environmentIndex < 0 || !['DEV', 'PRODUCTION'].includes(environment)) throw new Error();
  let snapshot;
  if (snapshotIndex >= 0) {
    snapshot = JSON.parse(await readFile(args[snapshotIndex + 1], 'utf8'));
  } else {
    if (!args.includes('--dev') || environment !== 'DEV') throw new Error();
    const url = new URL(process.env.DATABASE_URL ?? '');
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || decodeURIComponent(url.pathname.slice(1)) !== 'kalend_dev') throw new Error();
    client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    await client.query('BEGIN READ ONLY');
    const tables = await client.query(`SELECT to_regclass('public."EvolutionConnection"') AS connection, to_regclass('public."_prisma_migrations"') AS migrations`);
    const history = tables.rows[0].migrations ? (await client.query('SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"')).rows : [];
    if (history.some(row => row.finished_at == null && row.rolled_back_at == null)) throw new Error();
    const applied = history.filter(row => row.finished_at != null && row.rolled_back_at == null).map(row => row.migration_name);
    if (tables.rows[0].connection && !applied.includes('20261005160000_company_evolution')) throw new Error();
    let rows = [];
    if (tables.rows[0].connection) {
      const columns = new Set((await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='EvolutionConnection'`)).rows.map(row => row.column_name));
      const globalKey = columns.has('globalKey') ? 'e."globalKey"' : 'NULL::text AS "globalKey"';
      const binding = columns.has('environment') ? 'e.environment' : 'NULL::text AS environment';
      rows = (await client.query(`SELECT e.id::text AS id, e."companyId"::text AS "companyId", e."instanceName", ${globalKey}, ${binding}, (c.id IS NOT NULL) AS "companyExists" FROM "EvolutionConnection" e LEFT JOIN "Company" c ON c.id=e."companyId" ORDER BY e.id`)).rows;
    }
    snapshot = { rows, globalMigrationApplied: applied.includes('20261005200000_global_evolution') };
    await client.query('ROLLBACK');
  }
  if (!snapshot || !Array.isArray(snapshot.rows)) throw new Error();
  const result = evolutionPreflight(snapshot.rows, environment, snapshot.globalMigrationApplied === true);
  console.log(JSON.stringify(result));
  if (!result.compatible) process.exitCode = 2;
} catch {
  console.error('EVOLUTION_PREFLIGHT_FAILED: verifique o snapshot ou a configuração DEV; nenhum dado foi alterado.');
  process.exitCode = 1;
} finally { await client?.end().catch(() => {}); }
