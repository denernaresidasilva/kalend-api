import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

describe('normalized user email migration', () => {
  async function migration() {
    return readFile(new URL('../../prisma/migrations/20261025120000_user_email_normalized_unique/migration.sql', import.meta.url), 'utf8');
  }

  it('enforces case-insensitive, whitespace-normalized uniqueness for every writer', async () => {
    const db = new PGlite();
    try {
      await db.exec('CREATE TABLE "User" (id UUID PRIMARY KEY, email TEXT NOT NULL UNIQUE)');
      await db.exec(await migration());
      await db.query('INSERT INTO "User" (id,email) VALUES ($1,$2)', ['11111111-1111-4111-8111-111111111111', 'owner@example.test']);
      await expect(db.query('INSERT INTO "User" (id,email) VALUES ($1,$2)', ['22222222-2222-4222-8222-222222222222', ' OWNER@EXAMPLE.TEST '])).rejects.toThrow();
      await db.query('INSERT INTO "User" (id,email) VALUES ($1,$2)', ['33333333-3333-4333-8333-333333333333', 'another@example.test']);
    } finally {
      await db.close();
    }
  }, 15000);

  it('refuses to install if legacy rows already collide after normalization', async () => {
    const db = new PGlite();
    try {
      await db.exec('CREATE TABLE "User" (id UUID PRIMARY KEY, email TEXT NOT NULL UNIQUE)');
      await db.query('INSERT INTO "User" (id,email) VALUES ($1,$2),($3,$4)', [
        '11111111-1111-4111-8111-111111111111', 'owner@example.test',
        '22222222-2222-4222-8222-222222222222', 'OWNER@example.test',
      ]);
      await expect(db.exec(await migration())).rejects.toThrow(/duplicate identities exist/);
    } finally {
      await db.close();
    }
  }, 15000);
});
