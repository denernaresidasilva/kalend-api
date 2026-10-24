// Starts only a new temporary cluster owned by this process. No system services.
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
const bin = process.env.KALEND_PG_BIN;
if (!bin || !existsSync(join(bin, 'initdb')))
  throw Error('Set KALEND_PG_BIN to PostgreSQL 16 bin directory');
function run(name, args, options = {}) {
  const child = spawnSync(join(bin, name), args, {
    stdio: 'inherit',
    ...options,
  });
  if (child.error || child.status !== 0) throw Error(`${name} failed`);
}
const version = spawnSync(join(bin, 'postgres'), ['--version'], {
  encoding: 'utf8',
});
if (!/^postgres \(PostgreSQL\) 16\./.test(version.stdout ?? ''))
  throw Error('PostgreSQL 16 required');
const listener = createServer();
await new Promise((resolve, reject) => {
  listener.once('error', reject);
  listener.listen(0, '127.0.0.1', resolve);
});
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const directory = mkdtempSync('/tmp/kalend-native-pg-');
const database = `kalend_audit_ephemeral_${randomUUID().replaceAll('-', '')}`;
run('initdb', [
  '-D',
  directory,
  '-U',
  'kalend_bootstrap',
  '--auth=trust',
  '--no-locale',
  '-E',
  'UTF8',
]);
writeFileSync(join(directory, 'KALEND_AUDIT_EPHEMERAL'), database, {
  mode: 0o600,
});
let started = false;
try {
  run('pg_ctl', [
    '-D',
    directory,
    '-l',
    join(directory, 'server.log'),
    '-o',
    `-h 127.0.0.1 -p ${port} -k ${directory}`,
    '-w',
    'start',
  ]);
  started = true;
  // Bootstrap provisions the isolated cluster only. No test gets this identity.
  run('psql', [
    '-h',
    '127.0.0.1',
    '-p',
    String(port),
    '-U',
    'kalend_bootstrap',
    '-d',
    'postgres',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    'CREATE ROLE kalend_audit LOGIN NOSUPERUSER CREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS; GRANT pg_read_all_settings TO kalend_audit; ALTER ROLE kalend_bootstrap NOLOGIN;',
  ]);
  run('createdb', [
    '-h',
    '127.0.0.1',
    '-p',
    String(port),
    '-U',
    'kalend_audit',
    database,
  ]);
  const env = {
    ...process.env,
    DOTENV_CONFIG_PATH: '/dev/null',
    KALEND_NATIVE_PG_DATA: directory,
    KALEND_NATIVE_PG_URL: `postgresql://kalend_audit@127.0.0.1:${port}/${database}`,
  };
  delete env.DATABASE_URL;
  const child = spawnSync(
    process.execPath,
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      '--config',
      'vitest.config.native.ts',
      ...process.argv.slice(2),
    ],
    { stdio: 'inherit', env },
  );
  process.exitCode = child.status ?? 1;
  if (existsSync(join(directory, 'lock-evidence.json')))
    console.log(
      'NATIVE_LOCK_EVIDENCE',
      readFileSync(join(directory, 'lock-evidence.json'), 'utf8'),
    );
} finally {
  if (started) run('pg_ctl', ['-D', directory, '-m', 'fast', '-w', 'stop']);
  console.log(`Ephemeral data and logs retained: ${directory}`);
}
