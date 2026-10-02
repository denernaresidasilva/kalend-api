// Isolated PostgreSQL 16 only. Never reads DATABASE_URL or reuses an existing database.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Client } from 'pg';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { AppModule } from '../../dist/app.module.js';
import { CommunicationEngine } from '../../dist/communication/engine.js';
import { NotificationsService } from '../../dist/notifications/notifications.service.js';
import { AuthTokens, credentialHash } from '../../dist/auth/auth.tokens.js';
const connection = { host: '127.0.0.1', port: 55443, user: 'fixture' };
const database = 'kalend_notifications_disposable';
const admin = new Client({ ...connection, database: 'postgres' });
await admin.connect();
assert.match(
  (await admin.query('SHOW server_version')).rows[0].server_version,
  /^16\./,
);
assert.equal(
  (await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [database]))
    .rowCount,
  0,
  'Refuse existing DB',
);
await admin.query(`CREATE DATABASE ${database}`);
const sql = new Client({ ...connection, database });
const url = `postgresql://fixture@127.0.0.1:55443/${database}`;
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: url }),
});
let app;
let checks = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks++;
};
try {
  await sql.connect();
  const folders = (
    await readdir(new URL('../../prisma/migrations/', import.meta.url))
  )
    .filter((n) => n !== 'migration_lock.toml')
    .sort();
  for (const folder of folders)
    await sql.query(
      await readFile(
        new URL(
          `../../prisma/migrations/${folder}/migration.sql`,
          import.meta.url,
        ),
        'utf8',
      ),
    );
  check(true, 'all migrations applied');
  process.env.DATABASE_URL = url;
  process.env.AUTH_JWT_SECRET = randomBytes(32).toString('hex');
  process.env.GATEWAY_ENCRYPTION_KEY = randomBytes(32).toString('hex');
  process.env.AUTH_ALLOWED_ORIGINS = 'https://fixture.kalend.test';
  app = await NestFactory.create(AppModule, {
    logger: false,
    abortOnError: false,
  });
  await app.init();
  const service = app.get(NotificationsService),
    tokens = app.get(AuthTokens);
  const companies = [];
  for (let i = 0; i < 2; i++)
    companies.push(
      await prisma.company.create({
        data: { name: `Empresa ${i}`, slug: `notification-fixture-${i}` },
      }),
    );
  const roles = [
    'SUPER_ADMIN',
    'OWNER',
    'ADMIN',
    'PROFESSIONAL',
    'RECEPTIONIST',
    'CLIENT',
  ];
  const users = [];
  const cookies = [];
  const sessions = [];
  for (const role of roles) {
    const user = await prisma.user.create({
      data: {
        name: role,
        email: `${role.toLowerCase()}@notification.test`,
        passwordHash: 'fixture-hash',
        isSuperAdmin: role === 'SUPER_ADMIN',
      },
    });
    users.push(user);
    if (role !== 'SUPER_ADMIN')
      await prisma.membership.create({
        data: { userId: user.id, companyId: companies[0].id, role },
      });
    const session = await prisma.authSession.create({
      data: {
        userId: user.id,
        credentialHash: credentialHash(user.passwordHash),
        selectedCompanyId: role === 'SUPER_ADMIN' ? null : companies[0].id,
        expiresAt: new Date(Date.now() + 86400000),
        refreshExpiresAt: new Date(Date.now() + 86400000),
      },
    });
    sessions.push(session);
    cookies.push(
      `__Host-kalend_access=${await tokens.access(user.id, session.id, new Date(Date.now() + 300000))}`,
    );
  }
  await prisma.membership.create({
    data: { userId: users[1].id, companyId: companies[1].id, role: 'OWNER' },
  });
  await prisma.globalCommunicationOutbox.updateMany({
    data: { notificationProcessedAt: new Date() },
  }); // isolate from setup welcome triggers
  const ownerEvent = await prisma.globalCommunicationOutbox.create({
    data: {
      event: 'PAYMENT_APPROVED',
      businessKey: randomUUID(),
      companyId: companies[0].id,
      variables: {},
    },
  });
  for (const user of users)
    await prisma.globalCommunicationOutbox.create({
      data: {
        event: 'SECURITY_PASSWORD_CHANGED',
        businessKey: randomUUID(),
        userId: user.id,
        variables: {},
      },
    });
  const engine = app.get(CommunicationEngine);
  await engine.expand();
  check((await prisma.globalCommunicationOutbox.findUniqueOrThrow({where:{id:ownerEvent.id}})).expandedAt === null, 'delivery waits for persistent inbox processing');
  const oldSource = await prisma.globalCommunicationOutbox.create({data:{event:'PAYMENT_FAILED',businessKey:randomUUID(),companyId:companies[0].id,variables:{}}});
  await sql.query(`UPDATE "GlobalCommunicationOutbox" SET "createdAt" = LOCALTIMESTAMP - INTERVAL '168 hours 1 minute' WHERE id=$1`,[oldSource.id]);
  await Promise.all([service.ingest(), service.ingest()]);
  check(await prisma.notification.count({where:{sourceKey:oldSource.id}}) === 0, 'old source never recreates expired history');
  await engine.expand();
  check((await prisma.globalCommunicationOutbox.findUniqueOrThrow({where:{id:ownerEvent.id}})).expandedAt !== null, 'existing deliveries resume after inbox processing');
  const retained = await prisma.notification.findMany();
  check(retained.every(n => n.expiresAt.getTime()-n.createdAt.getTime()===604800000), 'generated expiry is exactly 168 hours for every notification');
  check(
    (await prisma.notification.count()) === 7,
    'single history per event/user, no delivery provider required',
  );
  check(
    (await prisma.notification.count({
      where: { userId: users[1].id, sourceKey: ownerEvent.id },
    })) === 1,
    'concurrent expansion idempotent',
  );
  for (let i = 0; i < users.length; i++) {
    const response = await request(app.getHttpServer())
      .get('/notifications')
      .set('Cookie', cookies[i])
      .expect(200);
    check(
      response.body.items.length === (i === 1 ? 2 : 1),
      `list isolates ${roles[i]}`,
    );
    check(
      response.body.items.every((n) => !('sourceKey' in n) && !('userId' in n)),
      'public metadata only',
    );
    check(response.headers['cache-control'].includes('no-store'), 'no-store');
    const count = await request(app.getHttpServer())
      .get('/notifications/unread-count')
      .set('Cookie', cookies[i])
      .expect(200);
    check(
      count.body.unreadCount === (i === 1 ? 2 : 1),
      `count isolates ${roles[i]}`,
    );
  }
  const own = await prisma.notification.findFirstOrThrow({
    where: { userId: users[1].id, companyId: companies[0].id },
  });
  const another = await prisma.notification.findFirstOrThrow({
    where: { userId: users[2].id },
  });
  await request(app.getHttpServer())
    .post(`/notifications/${another.id}/read`)
    .set('Cookie', cookies[1])
    .set('Origin', process.env.AUTH_ALLOWED_ORIGINS)
    .send({})
    .expect(404);
  check(true, 'cross user read rejected');
  await request(app.getHttpServer())
    .post(`/notifications/${own.id}/read`)
    .set('Cookie', cookies[1])
    .send({})
    .expect(403);
  check(true, 'CSRF origin required');
  await request(app.getHttpServer())
    .post(`/notifications/${own.id}/read`)
    .set('Cookie', cookies[1])
    .set('Origin', process.env.AUTH_ALLOWED_ORIGINS)
    .send({ companyId: companies[1].id })
    .expect(400);
  check(true, 'browser tenant override rejected');
  await request(app.getHttpServer())
    .post(`/notifications/${own.id}/read`)
    .set('Cookie', cookies[1])
    .set('Origin', process.env.AUTH_ALLOWED_ORIGINS)
    .send({})
    .expect(201);
  check(
    (await prisma.notification.findUniqueOrThrow({ where: { id: own.id } }))
      .readAt !== null,
    'read persisted',
  );
  const firstRead = (
    await prisma.notification.findUniqueOrThrow({ where: { id: own.id } })
  ).readAt;
  await request(app.getHttpServer())
    .post(`/notifications/${own.id}/read`)
    .set('Cookie', cookies[1])
    .set('Origin', process.env.AUTH_ALLOWED_ORIGINS)
    .send({})
    .expect(201);
  check(
    (
      await prisma.notification.findUniqueOrThrow({ where: { id: own.id } })
    ).readAt.getTime() === firstRead.getTime(),
    'read idempotent',
  );
  const readPage = await request(app.getHttpServer())
    .get('/notifications?filter=read')
    .set('Cookie', cookies[1])
    .expect(200);
  check(readPage.body.items.length === 1, 'read filter');
  const otherCompany = await prisma.notification.create({
    data: {
      userId: users[1].id,
      companyId: companies[1].id,
      sourceKey: randomUUID(),
      type: 'sistema',
      title: 'Outro contexto',
      message: 'Privado',
    },
  });
  await request(app.getHttpServer())
    .post(`/notifications/${otherCompany.id}/read`)
    .set('Cookie', cookies[1])
    .set('Origin', process.env.AUTH_ALLOWED_ORIGINS)
    .send({})
    .expect(404);
  check(true, 'cross tenant read rejected');
  await request(app.getHttpServer())
    .post('/notifications/read-all')
    .set('Cookie', cookies[1])
    .set('Origin', process.env.AUTH_ALLOWED_ORIGINS)
    .send({})
    .expect(201);
  check(
    (
      await prisma.notification.findUniqueOrThrow({
        where: { id: otherCompany.id },
      })
    ).readAt === null,
    'read-all leaves other tenant untouched',
  );
  check(
    (await prisma.notification.findUniqueOrThrow({ where: { id: another.id } }))
      .readAt === null,
    'read-all leaves other user untouched',
  );
  await prisma.authSession.update({
    where: { id: sessions[1].id },
    data: { selectedCompanyId: companies[1].id },
  });
  const switched = await request(app.getHttpServer())
    .get('/notifications')
    .set('Cookie', cookies[1])
    .expect(200);
  check(
    switched.body.items.some((n) => n.id === otherCompany.id) &&
      !switched.body.items.some((n) => n.id === own.id),
    'session company switch respected',
  );
  await prisma.authSession.update({
    where: { id: sessions[1].id },
    data: { selectedCompanyId: companies[0].id },
  });
  await prisma.membership.updateMany({
    where: { userId: users[1].id, companyId: companies[0].id },
    data: { isActive: false },
  });
  await request(app.getHttpServer())
    .get('/notifications/unread-count')
    .set('Cookie', cookies[1])
    .expect(403);
  check(true, 'revoked membership rejected');
  await prisma.membership.updateMany({
    where: { userId: users[1].id, companyId: companies[0].id },
    data: { isActive: true },
  });
  await request(app.getHttpServer())
    .get('/notifications?userId=arbitrary')
    .set('Cookie', cookies[1])
    .expect(400);
  await request(app.getHttpServer())
    .get('/notifications?limit=21')
    .set('Cookie', cookies[1])
    .expect(400);
  await request(app.getHttpServer())
    .get('/notifications?cursor=bad')
    .set('Cookie', cookies[1])
    .expect(400);
  check(true, 'malformed queries rejected');
  const createdAt = new Date(Math.floor(Date.now() / 1000) * 1000);
  for (let i = 0; i < 25; i++)
    await prisma.notification.create({
      data: {
        userId: users[1].id,
        companyId: companies[0].id,
        sourceKey: randomUUID(),
        type: 'sistema',
        title: `Página ${i}`,
        message: 'Texto',
        createdAt,
        actionUrl: i === 0 ? 'https://evil.test' : '/conta',
      },
    });
  let cursor = null;
  let all = [];
  do {
    const res = await request(app.getHttpServer())
      .get(
        '/notifications?limit=20' +
          (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
      )
      .set('Cookie', cookies[1])
      .expect(200);
    check(res.body.items.length <= 20, 'bounded page');
    all.push(...res.body.items);
    cursor = res.body.nextCursor;
  } while (cursor);
  check(
    all.length === 27 && new Set(all.map((n) => n.id)).size === 27,
    'stable pagination no lost/duplicate records',
  );
  check(
    all.find((n) => n.title === 'Página 0').actionUrl === null,
    'unsafe stored URL stripped',
  );
  await request(app.getHttpServer())
    .put('/notifications/preferences')
    .set('Cookie', cookies[1])
    .set('Origin', process.env.AUTH_ALLOWED_ORIGINS)
    .send({ inSystemEnabled: false })
    .expect(200);
  const disabled = await prisma.globalCommunicationOutbox.create({
    data: {
      event: 'PAYMENT_PENDING',
      businessKey: randomUUID(),
      companyId: companies[0].id,
      variables: {},
    },
  });
  await service.ingest();
  check(
    (await prisma.notification.count({ where: { sourceKey: disabled.id } })) ===
      0,
    'persisted disabled preference prevents new history',
  );
  check(
    (
      await request(app.getHttpServer())
        .get('/notifications/preferences')
        .set('Cookie', cookies[1])
        .expect(200)
    ).body.inSystemEnabled === false,
    'preference reload persists',
  );
  await sql.query(
    `INSERT INTO "Notification" (id,"userId","sourceKey",type,title,message,"createdAt") VALUES ($1,$2,$3,'sistema','Expirada','Fixture', (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '168 hours 1 minute')`,
    [randomUUID(), users[1].id, randomUUID()],
  );
  check(
    (
      await sql.query(
        `SELECT count(*)::int AS n FROM "Notification" WHERE "expiresAt"<=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')`,
      )
    ).rows[0].n === 1,
    'expired record physically exists before scheduler',
  );
  const countBefore = (
    await request(app.getHttpServer())
      .get('/notifications/unread-count')
      .set('Cookie', cookies[1])
      .expect(200)
  ).body.unreadCount;
  check(countBefore === 25, 'backend excludes expiry using server time');
  await assert.rejects(
    sql.query(
      `INSERT INTO "Notification" (id,"userId","sourceKey",type,title,message,"createdAt","expiresAt") VALUES ($1,$2,$3,'sistema','Bad','Bad',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+INTERVAL '8 days')`,
      [randomUUID(), users[1].id, randomUUID()],
    ),
    { code: '428C9' },
  );
  check(
    true,
    'database rejects explicit override of generated seven-day expiry',
  );
  const scheduler = execFileSync(
    process.execPath,
    ['dist/communication/scheduler.js'],
    {
      cwd: new URL('../../', import.meta.url),
      env: { ...process.env, COMMUNICATION_SCHEDULER_ENABLED: 'true' },
      encoding: 'utf8',
    },
  );
  check(
    JSON.parse(scheduler.trim()).inboxCleanup.deleted === 1,
    'actual scheduler invocation deletes physically',
  );
  check(
    (
      await sql.query(
        `SELECT count(*)::int AS n FROM "Notification" WHERE "expiresAt"<=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')`,
      )
    ).rows[0].n === 0,
    'cleanup needs no browser or page access',
  );
  check((await service.cleanup()).deleted === 0, 'cleanup idempotent');
  await service.ingest();
  check(
    (await prisma.notification.count({ where: { sourceKey: disabled.id } })) ===
      0,
    'processed sources not recreated',
  );
  await request(app.getHttpServer()).put('/notifications/preferences').set('Cookie',cookies[1]).set('Origin',process.env.AUTH_ALLOWED_ORIGINS).send({inSystemEnabled:true}).expect(200);
  const workerSource = await prisma.globalCommunicationOutbox.create({data:{event:'PAYMENT_FAILED',businessKey:randomUUID(),companyId:companies[0].id,variables:{}}});
  const worker=execFileSync(process.execPath,['dist/communication/worker.js'],{cwd:new URL('../../',import.meta.url),env:{...process.env,COMMUNICATION_WORKER_ENABLED:'true'},encoding:'utf8'});
  check(JSON.parse(worker.trim()).inbox.created === 1, 'actual worker persists history independently of disabled delivery providers');
  check(await prisma.notification.count({where:{sourceKey:workerSource.id,userId:users[1].id}}) === 1, 'worker source is retained in central');
  await request(app.getHttpServer()).get('/notifications').expect(401);
  check(true, 'unauthenticated rejected');
  await prisma.authSession.update({
    where: { id: sessions[1].id },
    data: { revokedAt: new Date() },
  });
  await request(app.getHttpServer())
    .get('/notifications')
    .set('Cookie', cookies[1])
    .expect(401);
  check(true, 'revoked session rejected');
  console.log(
    JSON.stringify({
      postgres: '16',
      checks,
      result: 'passed',
      fixtureOnly: true,
      livePushDelivery: false,
    }),
  );
} finally {
  await app?.close();
  await prisma.$disconnect();
  await sql.end();
  await admin.query(`DROP DATABASE ${database}`);
  await admin.end();
}
