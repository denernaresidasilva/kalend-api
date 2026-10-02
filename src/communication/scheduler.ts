import { NotificationsService } from '../notifications/notifications.service.js';
import { GlobalPush } from './push.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { LifecycleService } from '../billing/lifecycle.service.js';
import { CommunicationEngine } from './engine.js';
// Explicit, separately supervised domain scheduler. Does not send messages.
if (process.env.COMMUNICATION_SCHEDULER_ENABLED !== 'true') {
  console.error('COMMUNICATION_SCHEDULER_DISABLED');
  process.exitCode = 1;
} else {
  try {
    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
      abortOnError: false,
    });
    try {
      const inboxCleanup = await app.get(NotificationsService).cleanup();
      const commercial = await app.get(LifecycleService).reconcile();
      await app.get(GlobalPush).cleanup();
      const temporal = await app.get(CommunicationEngine).temporal();
      const inbox = await app.get(NotificationsService).ingest();
      console.log(
        JSON.stringify({ commercial, temporal, inbox, inboxCleanup }),
      );
    } finally {
      await app.close();
    }
  } catch {
    console.error('COMMUNICATION_SCHEDULER_FAILED');
    process.exitCode = 1;
  }
}
