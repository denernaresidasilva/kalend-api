import { Client } from 'pg';
import { readFileSync, realpathSync, statSync } from 'node:fs';

export function nativeTarget() {
  const value = process.env.KALEND_NATIVE_PG_URL;
  const directory = process.env.KALEND_NATIVE_PG_DATA;
  if (!value || !directory) throw Error('NATIVE_FIXTURE_REQUIRED');
  const url = new URL(value);
  if (
    url.hostname !== '127.0.0.1' ||
    url.username !== 'kalend_audit' ||
    Number(url.port) < 1024 ||
    !/^\/kalend_audit_ephemeral_[a-z0-9]+$/.test(url.pathname) ||
    !/^\/tmp\/kalend-native-pg-[a-zA-Z0-9]+$/.test(directory) ||
    realpathSync(directory) !== directory ||
    statSync(directory).uid !== process.getuid?.() ||
    readFileSync(`${directory}/KALEND_AUDIT_EPHEMERAL`, 'utf8') !==
      url.pathname.slice(1)
  )
    throw Error('EPHEMERAL_DATABASE_REQUIRED');
  return { connectionString: value, directory };
}
export async function nativeLegacyDatabase() {
  const target = nativeTarget();
  const client = new Client({ connectionString: target.connectionString });
  await client.connect();
  const directory = await client.query('SHOW data_directory');
  if (directory.rows[0].data_directory !== target.directory) {
    await client.end();
    throw Error('WRONG_CLUSTER');
  }
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  return {
    exec: (sql: string) => client.query(sql),
    query: (sql: string, params?: unknown[]) => client.query(sql, params),
    close: () => client.end(),
  };
}
