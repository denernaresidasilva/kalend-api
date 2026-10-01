// Run only against the isolated cluster created for this audit. No DATABASE_URL is read.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Client } from 'pg';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const database = 'kalend_push_disposable';
const connection = { host: '127.0.0.1', port: 55441, user: 'fixture' };
const admin = new Client({ ...connection, database: 'postgres' });
await admin.connect();
const version = (await admin.query('SHOW server_version')).rows[0]
  .server_version;
assert.ok(version.startsWith('16.'), 'Disposable PostgreSQL 16 required');
// Refuse to reuse an existing database. Never drop a database we did not create.
assert.equal(
  (await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [database]))
    .rowCount,
  0,
);
await admin.query(`CREATE DATABASE ${database}`);
const db = new Client({ ...connection, database });
let checks = 0;
try {
  await db.connect();
  const folders = (
    await readdir(new URL('../../prisma/migrations/', import.meta.url))
  ).sort();
  const migration = '20260930193000_push_device_authorizations';
  for (const folder of folders.filter(
    (name) => name < migration && name !== 'migration_lock.toml',
  )) {
    await db.query(
      await readFile(
        new URL(
          `../../prisma/migrations/${folder}/migration.sql`,
          import.meta.url,
        ),
        'utf8',
      ),
    );
  }
  const owner = '11111111-1111-4111-8111-111111111111';
  const other = '22222222-2222-4222-8222-222222222222';
  const company = '33333333-3333-4333-8333-333333333333';
  const device = '44444444-4444-4444-8444-444444444444';
  await db.query(
    `INSERT INTO "User" (id,email,"passwordHash",name,"updatedAt") VALUES ($1,'owner@example.test','fixture','Owner',now()), ($2,'other@example.test','fixture','Other',now())`,
    [owner, other],
  );
  await db.query(
    `INSERT INTO "Company" (id,name,slug,"updatedAt") VALUES ($1,'Fixture','push-migration-fixture',now())`,
    [company],
  );
  await db.query(
    `INSERT INTO "Membership" (id,"userId","companyId",role,"updatedAt") VALUES ('55555555-5555-4555-8555-555555555555',$1,$3,'OWNER',now()),('66666666-6666-4666-8666-666666666666',$2,$3,'OWNER',now())`,
    [owner, other, company],
  );
  await db.query(
    `INSERT INTO "GlobalCommunicationProvider" (provider,environment,config,"updatedAt") VALUES ('PUSH_PENDING','PRODUCTION','{}',now())`,
  );
  await db.query(
    `INSERT INTO "GlobalPushSubscription" (id,"userId","endpointHash","credentialsEncrypted","vapidPublicKey","updatedAt") VALUES ($1,$2,$3,'encrypted-fixture','public-fixture',now())`,
    [device, owner, 'a'.repeat(64)],
  );
  await db.query(
    await readFile(
      new URL(
        `../../prisma/migrations/${migration}/migration.sql`,
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const row = (
    await db.query(`SELECT * FROM "GlobalPushSubscription" WHERE id=$1`, [
      device,
    ])
  ).rows[0];
  assert.equal(row.environment, 'PRODUCTION');
  checks++;
  assert.equal(row.credentialsEncrypted, 'encrypted-fixture');
  checks++;
  assert.equal(row.active, true);
  checks++;
  assert.equal(row.lastUsedAt, null);
  checks++;
  assert.equal(
    (await db.query(`SELECT count(*)::int AS n FROM "GlobalPushAuthorization"`))
      .rows[0].n,
    0,
  );
  checks++;
  const insert = `INSERT INTO "GlobalPushAuthorization" ("subscriptionId","userId","companyId","updatedAt") VALUES ($1,$2,$3,now())`;
  await assert.rejects(db.query(insert, [device, other, company]), {
    code: '23503',
  });
  checks++;
  await assert.rejects(
    db.query(insert, [device, owner, '77777777-7777-4777-8777-777777777777']),
    { code: '23503' },
  );
  checks++;
  await db.query(insert, [device, owner, company]);
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ ...connection, database }),
  });
  try {
    const where = {
      userId: owner,
      environment: 'PRODUCTION',
      scope: 'GLOBAL',
      active: true,
      revokedAt: null,
      provider: 'WEB_PUSH',
      authorizations: {
        some: {
          companyId: company,
          userId: owner,
          active: true,
          revokedAt: null,
          membership: {
            isActive: true,
            company: {
              OR: [
                { isActive: true },
                { status: { in: ['SUSPENDED', 'CANCELED'] } },
              ],
            },
          },
        },
      },
    };
    assert.equal(
      (
        await prisma.globalPushSubscription.findMany({
          where,
          select: { id: true },
        })
      ).length,
      1,
    );
    checks++;
    await prisma.globalPushAuthorization.updateMany({
      where: { subscriptionId: device, companyId: company },
      data: { active: false },
    });
    assert.equal(
      (
        await prisma.globalPushSubscription.findMany({
          where,
          select: { id: true },
        })
      ).length,
      0,
    );
    checks++;
    await prisma.globalPushAuthorization.updateMany({
      where: { subscriptionId: device, companyId: company },
      data: { active: true },
    });
    await prisma.membership.updateMany({
      where: { userId: owner, companyId: company },
      data: { isActive: false },
    });
    assert.equal(
      (
        await prisma.globalPushSubscription.findMany({
          where,
          select: { id: true },
        })
      ).length,
      0,
    );
    checks++;
  } finally {
    await prisma.$disconnect();
  }
  await assert.rejects(db.query(insert, [device, owner, company]), {
    code: '23505',
  });
  checks++;
  await db.query(
    `DELETE FROM "Membership" WHERE "userId"=$1 AND "companyId"=$2`,
    [owner, company],
  );
  assert.equal(
    (await db.query(`SELECT count(*)::int AS n FROM "GlobalPushAuthorization"`))
      .rows[0].n,
    0,
  );
  checks++;
  assert.equal(
    (await db.query(`SELECT count(*)::int AS n FROM "GlobalPushSubscription"`))
      .rows[0].n,
    1,
  );
  checks++;
  const constraints = await db.query(
    `SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid='"GlobalPushAuthorization"'::regclass AND contype='f'`,
  );
  assert.equal(constraints.rows[0].n, 2);
  checks++;
  console.log(
    JSON.stringify({
      migration,
      checks,
      result: 'PASS',
      server: `PostgreSQL ${version} disposable`,
    }),
  );
} finally {
  await db.end();
  await admin.query(`DROP DATABASE ${database}`);
  await admin.end();
}
