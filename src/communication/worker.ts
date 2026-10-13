import { NotificationsService } from '../notifications/notifications.service.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { CommunicationEngine } from './engine.js';
import { qaCommunicationEnabled } from './qa-policy.js';
// One bounded invocation, intended for a supervised external timer. No HTTP listener or in-process interval.
const qaOnly = process.argv.includes('--qa-only');
if (
  process.env.COMMUNICATION_WORKER_ENABLED !== 'true' ||
  (qaOnly && !qaCommunicationEnabled())
) {
  console.error('COMMUNICATION_WORKER_DISABLED');
  process.exitCode = 1;
} else {
  try {
    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
      abortOnError: false,
    });
    try {
      const engine = app.get(CommunicationEngine);
      if (qaOnly) {
        console.log(JSON.stringify(await engine.runQaOnly()));
      } else {
        await engine.temporal();
        const inbox = await app.get(NotificationsService).ingest();
        console.log(JSON.stringify({ ...(await engine.run()), inbox }));
      }
    } finally {
      await app.close();
    }
  } catch {
    console.error('COMMUNICATION_WORKER_FAILED');
    process.exitCode = 1;
  }
}
