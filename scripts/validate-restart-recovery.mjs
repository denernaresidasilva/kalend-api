// Two real Node processes + disk-backed disposable PostgreSQL/PGlite. No remote DB.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { CommunicationEngine } from '../dist/communication/engine.js';
import { entitledWhere, effectiveAccessStatus } from '../dist/billing/commercial-policy.js';
const phase = process.argv[2];
if (!phase) {
  const dir = await mkdtemp(join(tmpdir(), 'QA-E2E-restart-'));
  const ids = { runId: `${Date.now()}-${randomUUID().slice(0,8)}`, company: randomUUID(), plan: randomUUID(), subscription: randomUUID(), outbox: randomUUID(), retry: randomUUID(), sending: randomUUID(), user: randomUUID(), template: randomUUID() };
  await writeFile(join(dir,'ids.json'),JSON.stringify(ids));
  try {
    for (const action of ['seed','recover']) {
      const result = spawnSync(process.execPath,[fileURLToPath(import.meta.url),action,dir], { encoding: 'utf8', timeout: 60_000 });
      process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || ''); assert.equal(result.status,0,`restart phase ${action}`);
    }
    console.log(JSON.stringify({ type: 'TESTE INTEGRAÇÃO', database: 'PGlite persistido em disco QA', externalProviders: 'NÃO TESTADOS', checks: 10, status: 'PASSOU' }));
  } finally { await rm(dir, { recursive: true, force: true }); } // Only exact mkdtemp directory owned by this run.
} else {
  const dir = process.argv[3];
  if (!['seed','recover'].includes(phase) || !dir?.startsWith(join(tmpdir(),'QA-E2E-restart-'))) throw new Error('Fixture path inválido');
  const ids = JSON.parse(await readFile(join(dir,'ids.json'),'utf8'));
  const sql = await PGlite.create(join(dir,'postgres'));
  const socket = new PGLiteSocketServer({ db: sql, host: '127.0.0.1', port: 55451 });
  let prisma;
  try {
    if (phase === 'seed') for (const folder of (await readdir(new URL('../prisma/migrations/',import.meta.url))).filter(n=>n!=='migration_lock.toml').sort()) await sql.exec(await readFile(new URL(`../prisma/migrations/${folder}/migration.sql`,import.meta.url),'utf8'));
    await socket.start();
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: 'postgresql://qa@127.0.0.1:55451/qa_restart', max: 1 }) });
    if (phase === 'seed') {
      await prisma.plan.create({ data: { id: ids.plan, name: 'Plano QA restart', code: ids.runId, monthlyPriceCents: 9900 } });
      await prisma.company.create({ data: { id: ids.company, name: `QA-E2E-${ids.runId}`, slug: `qa-e2e-${ids.runId}` } });
      await prisma.subscription.create({ data: { id: ids.subscription, companyId: ids.company, planId: ids.plan, status: 'TRIALING', trialStartedAt: new Date(Date.now()-8*86400000), trialEndsAt: new Date(Date.now()-86400000) } });
      await prisma.globalCommunicationOutbox.create({ data: { id: ids.outbox, companyId: ids.company, event: 'TRIAL_EXPIRED', businessKey: `QA-E2E-${ids.runId}:restart`, variables: { correlation: ids.runId } } });
      const data = { outboxId: ids.outbox, userId: ids.user, channel: 'EMAIL', provider: 'SMTP', environment: 'SANDBOX', configurationRevision: 1, templateId: ids.template, templateRevision: 1, recipientMasked: 'qa***', attempts: 1 };
      await prisma.globalCommunicationDelivery.create({ data: { ...data, id: ids.retry, status: 'RETRY', nextAttemptAt: new Date(Date.now()+86400000) } });
      await prisma.globalCommunicationDelivery.create({ data: { ...data, id: ids.sending, targetKey: 'SENDING-QA', status: 'SENDING', startedAt: new Date(Date.now()-600000) } });
      console.log('Processo A: trial/evento/outbox/retry/SENDING persistidos; encerramento do banco e processo.');
    } else {
      assert.equal((await prisma.company.findUnique({ where: { id: ids.company } })).name,`QA-E2E-${ids.runId}`);
      const subscription = await prisma.subscription.findUnique({ where: { id: ids.subscription } }); assert.equal(subscription.status,'TRIALING');
      assert.ok(subscription.trialEndsAt < new Date());
      assert.equal(await prisma.subscription.count({ where: entitledWhere(ids.company) }),0);
      assert.equal(effectiveAccessStatus(null,subscription,new Date()),'TRIAL_EXPIRED');
      assert.equal(await prisma.globalCommunicationOutbox.count({ where: { id: ids.outbox } }),1);
      assert.equal((await prisma.globalCommunicationDelivery.findUnique({ where: { id: ids.retry } })).status,'RETRY');
      const engine = new CommunicationEngine(prisma, {}, {}, {}); await engine.run();
      assert.equal((await prisma.globalCommunicationDelivery.findUnique({ where: { id: ids.sending } })).status,'UNCERTAIN');
      assert.equal((await prisma.globalCommunicationDelivery.findUnique({ where: { id: ids.retry } })).status,'RETRY');
      assert.equal(await prisma.globalCommunicationOutbox.count({ where: { id: ids.outbox } }),1);
      console.log('Processo B: 10 asserções; acesso expirado sem scheduler e dados/retry preservados; SENDING quarantined UNCERTAIN.');
    }
  } finally { await prisma?.$disconnect(); await socket.stop(); await sql.close(); }
}
