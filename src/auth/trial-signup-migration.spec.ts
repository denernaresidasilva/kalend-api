import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

describe('public trial signup consent migration', () => {
  it('creates consent with tenant/user integrity, uniqueness, and privacy-safe defaults', async () => {
    const db = new PGlite();
    try {
      await db.exec(`CREATE TABLE "User" (id UUID PRIMARY KEY); CREATE TABLE "Company" (id UUID PRIMARY KEY);`);
      const migration = await readFile(new URL('../../prisma/migrations/20261025090000_public_trial_signup_consent/migration.sql', import.meta.url), 'utf8');
      await db.exec(migration);
      const userId = '11111111-1111-4111-8111-111111111111';
      const companyId = '22222222-2222-4222-8222-222222222222';
      await db.query('INSERT INTO "User" (id) VALUES ($1)', [userId]);
      await db.query('INSERT INTO "Company" (id) VALUES ($1)', [companyId]);
      const inserted = await db.query<{ source: string; marketingOptIn: boolean; acceptedAt: Date }>(
        'INSERT INTO "PublicSignupConsent" ("userId", "companyId", "termsVersion", "privacyVersion") VALUES ($1,$2,$3,$4) RETURNING source, "marketingOptIn", "acceptedAt"',
        [userId, companyId, '2026-10', '2026-10'],
      );
      expect(inserted.rows[0]).toMatchObject({ source: 'PUBLIC_LP', marketingOptIn: false });
      expect(inserted.rows[0].acceptedAt).toBeTruthy();
      await expect(db.query(
        'INSERT INTO "PublicSignupConsent" ("userId", "companyId", "termsVersion", "privacyVersion") VALUES ($1,$2,$3,$4)',
        [userId, companyId, '2026-10', '2026-10'],
      )).rejects.toThrow();
      await expect(db.query(
        'INSERT INTO "PublicSignupConsent" ("userId", "companyId", "termsVersion", "privacyVersion") VALUES ($1,$2,$3,$4)',
        ['33333333-3333-4333-8333-333333333333', companyId, '2026-10', '2026-10'],
      )).rejects.toThrow();
      const indexNames = await db.query<{ indexname: string }>(`SELECT indexname FROM pg_indexes WHERE tablename = 'PublicSignupConsent'`);
      expect(indexNames.rows.map(({ indexname }) => indexname)).toEqual(expect.arrayContaining([
        'PublicSignupConsent_userId_companyId_key', 'PublicSignupConsent_companyId_acceptedAt_idx',
      ]));
    } finally {
      await db.close();
    }
  });
});
