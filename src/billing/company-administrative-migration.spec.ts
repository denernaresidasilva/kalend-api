import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

it('conservatively backfills only clearly active companies without changing commercial data', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE "Company" (id integer PRIMARY KEY, status text, "isActive" boolean, "updatedAt" text);
      INSERT INTO "Company" VALUES (1,'ACTIVE',true,'unchanged'),(2,'TRIAL',true,'unchanged'),(3,'SUSPENDED',false,'unchanged'),(4,'ACTIVE',false,'unchanged'),(5,'CANCELED',true,'unchanged');`);
    const before = await db.query('SELECT * FROM "Company" ORDER BY id');
    await db.exec(
      await readFile(
        new URL(
          '../../prisma/migrations/20261016090000_company_administrative_recovery/migration.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const after = await db.query<{ administrativeStatus: string }>(
      'SELECT * FROM "Company" ORDER BY id',
    );
    expect(after.rows.map((r) => r.administrativeStatus)).toEqual([
      'ACTIVE',
      'ACTIVE',
      'LEGACY_UNKNOWN',
      'LEGACY_UNKNOWN',
      'LEGACY_UNKNOWN',
    ]);
    expect(
      after.rows.map(row => { const original = { ...row }; Reflect.deleteProperty(original, 'administrativeStatus'); return original; }),
    ).toEqual(before.rows);
    await db.exec(
      `INSERT INTO "Company" (id,status,"isActive") VALUES (6,'TRIAL',true)`,
    );
    expect(
      (
        await db.query(
          'SELECT "administrativeStatus" FROM "Company" WHERE id=6',
        )
      ).rows,
    ).toEqual([{ administrativeStatus: 'ACTIVE' }]);
  } finally {
    await db.close();
  }
});
