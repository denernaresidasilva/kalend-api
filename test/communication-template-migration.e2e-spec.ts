import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const migrationPath = new URL(
  '../prisma/migrations/20261013160000_company_communication_templates/migration.sql',
  import.meta.url,
);

async function baseline(db: PGlite, withGlobalRow: boolean) {
  await db.exec(`
    CREATE TYPE "CommunicationScope" AS ENUM ('GLOBAL');
    CREATE TYPE "CommunicationChannel" AS ENUM ('EMAIL', 'WHATSAPP', 'PUSH');
    CREATE TABLE "Company" ("id" UUID PRIMARY KEY);
    CREATE TABLE "GlobalCommunicationDelivery" (
      "id" UUID PRIMARY KEY,
      "scope" "CommunicationScope" NOT NULL DEFAULT 'GLOBAL'
    );
    CREATE TABLE "GlobalCommunicationTemplate" (
      "id" UUID PRIMARY KEY,
      "scope" "CommunicationScope" NOT NULL DEFAULT 'GLOBAL',
      "event" TEXT NOT NULL,
      "channel" "CommunicationChannel" NOT NULL,
      "provider" TEXT NOT NULL,
      "enabled" BOOLEAN NOT NULL DEFAULT FALSE,
      "content" JSONB NOT NULL,
      "revision" INTEGER NOT NULL DEFAULT 1,
      "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
      "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
      UNIQUE ("event", "channel")
    );
  `);
  if (withGlobalRow)
    await db.query(`INSERT INTO "GlobalCommunicationTemplate" ("id","event","channel","provider","enabled","content") VALUES ($1,'OWNER_WELCOME','EMAIL','SMTP',true,$2)`, [
      '11111111-1111-4111-8111-111111111111',
      JSON.stringify({ subject: 'Global preservado', text: 'Conteúdo global' }),
    ]);
}

describe('Company communication template migration', () => {
  it.each([false, true])('applies on a blank application schema and preserves GLOBAL rows (existing=%s)', async (withGlobalRow) => {
    const db = new PGlite();
    try {
      await baseline(db, withGlobalRow);
      await db.exec(await readFile(migrationPath, 'utf8'));
      const scope = await db.query(`SELECT unnest(enum_range(NULL::"CommunicationScope"))::text AS value`);
      expect((scope.rows as { value: string }[]).map((row) => row.value)).toEqual(['GLOBAL', 'COMPANY']);
      const delivery = await db.query(`SELECT "templateScope" FROM "GlobalCommunicationDelivery"`);
      expect(delivery.rows).toEqual([]);
      const company = await db.query(`SELECT "id" FROM "CompanyCommunicationTemplate"`);
      expect(company.rows).toEqual([]);
      if (withGlobalRow) {
        const global = await db.query(`SELECT "event","channel","enabled","content" FROM "GlobalCommunicationTemplate"`);
        expect(global.rows).toEqual([{
          event: 'OWNER_WELCOME', channel: 'EMAIL', enabled: true,
          content: { subject: 'Global preservado', text: 'Conteúdo global' },
        }]);
      }
      const companyId = '22222222-2222-4222-8222-222222222222';
      await db.query(`INSERT INTO "Company" ("id") VALUES ($1)`, [companyId]);
      await db.query(`INSERT INTO "CompanyCommunicationTemplate" ("id","companyId","event","channel","content","updatedAt") VALUES ($1,$2,'OWNER_WELCOME','EMAIL',$3,now())`, [
        '33333333-3333-4333-8333-333333333333', companyId,
        JSON.stringify({ subject: 'Override', text: 'Empresa' }),
      ]);
      await expect(db.query(`INSERT INTO "CompanyCommunicationTemplate" ("id","companyId","event","channel","content","updatedAt") VALUES ($1,$2,'OWNER_WELCOME','EMAIL','{}',now())`, [
        '44444444-4444-4444-8444-444444444444', companyId,
      ])).rejects.toThrow();
      await db.query(`DELETE FROM "Company" WHERE "id"=$1`, [companyId]);
      const afterDelete = await db.query(`SELECT count(*)::int AS count FROM "CompanyCommunicationTemplate"`);
      expect((afterDelete.rows[0] as { count: number }).count).toBe(0);
    } finally {
      await db.close();
    }
  });
});
