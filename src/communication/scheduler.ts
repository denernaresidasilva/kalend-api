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
      const commercial = await app.get(LifecycleService).reconcile();
      const temporal = await app.get(CommunicationEngine).temporal();
      console.log(JSON.stringify({ commercial, temporal }));
    } finally {
      await app.close();
    }
  } catch {
    console.error('COMMUNICATION_SCHEDULER_FAILED');
    process.exitCode = 1;
  }
}
