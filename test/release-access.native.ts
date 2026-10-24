import { Pool } from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import {
  nativeLegacyDatabase,
  nativeTarget,
} from './support/native-postgres.js';

it('proposed audit role reads the fixed classifier but cannot write even with read-only default disabled', async () => {
  const target = nativeTarget();
  const fixture = await nativeLegacyDatabase();
  const identity = await fixture.query(
    'SELECT rolsuper FROM pg_roles WHERE rolname=current_user',
  );
  expect(identity.rows[0].rolsuper).toBe(false);
  const root = new URL('../prisma/migrations/', import.meta.url);
  for (const name of (await readdir(root)).sort())
    if (
      name !== 'migration_lock.toml' &&
      name < '20261017090000_subscription_entitlement_evidence'
    )
      await fixture.exec(
        await readFile(new URL(`${name}/migration.sql`, root), 'utf8'),
      );
  await fixture.exec(
    'CREATE TABLE public._prisma_migrations (migration_name text)',
  );
  const database = new URL(target.connectionString).pathname.slice(1);
  const proposedSql = await readFile(
    'docs/homologacao/release-controlada/readonly-role.sql',
    'utf8',
  );
  await expect(fixture.exec(proposedSql)).rejects.toThrow('WRONG_DATABASE');
  await fixture.exec('ROLLBACK');
  const absent = await fixture.query(
    "SELECT count(*)::int AS count FROM pg_roles WHERE rolname='kalend_dev_audit'",
  );
  expect(absent.rows[0].count).toBe(0);
  const roleSql = proposedSql
    .replace('ON DATABASE kalend_dev ', `ON DATABASE "${database}" `)
    .replace(
      "current_database() <> 'kalend_dev'",
      `current_database() <> '${database}'`,
    );
  await fixture.exec(roleSql);
  const url = new URL(target.connectionString);
  url.username = 'kalend_dev_audit';
  const restricted = new Pool({ connectionString: url.toString(), max: 1 });
  const session = await restricted.connect();
  try {
    expect(
      (await session.query('SHOW default_transaction_read_only')).rows[0]
        .default_transaction_read_only,
    ).toBe('on');
    const flags = await session.query(
      'SELECT rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user',
    );
    expect(Object.values(flags.rows[0])).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    const report = await session.query(
      await readFile(
        'docs/homologacao/release-controlada/backfill-audit.sql',
        'utf8',
      ),
    );
    expect(report.rows[0].report.subscription_count).toBe(0);
    const limits = await session.query(
      'SELECT rolinherit,rolconnlimit FROM pg_roles WHERE rolname=current_user',
    );
    expect(limits.rows[0]).toEqual({ rolinherit: false, rolconnlimit: 2 });
    await session.query('SET default_transaction_read_only=off');
    await expect(
      session.query(
        'INSERT INTO public."Payment" (id) VALUES (gen_random_uuid())',
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      session.query('UPDATE public."Subscription" SET status=status'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      session.query('DELETE FROM public."Payment"'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      session.query('SELECT * FROM public."User"'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(session.query('SET ROLE kalend_audit')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(
      session.query('CREATE TABLE public.forbidden_fixture (id int)'),
    ).rejects.toMatchObject({ code: '42501' });
    await fixture.exec(
      'ALTER TABLE public."Subscription" ENABLE ROW LEVEL SECURITY; CREATE POLICY hidden_rows ON public."Subscription" TO kalend_dev_audit USING (false)',
    );
    await expect(
      session.query(
        await readFile(
          'docs/homologacao/release-controlada/backfill-audit.sql',
          'utf8',
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  } finally {
    session.release();
    await restricted.end();
    await fixture.close();
  }
}, 30000);
