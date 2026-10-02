import { NotificationsService } from '../notifications/notifications.service.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { CommunicationEngine } from './engine.js';
// One bounded invocation, intended for a supervised external timer. No HTTP listener or in-process interval.
if (process.env.COMMUNICATION_WORKER_ENABLED !== 'true') {
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
      await engine.temporal();
      const inbox = await app.get(NotificationsService).ingest();
      console.log(JSON.stringify({ ...(await engine.run()), inbox }));
    } finally {
      await app.close();
    }
  } catch {
    console.error('COMMUNICATION_WORKER_FAILED');
    process.exitCode = 1;
  }
}
