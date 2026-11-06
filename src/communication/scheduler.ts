import { ClientSubscriptionsService } from '../operations/client-subscriptions.service.js';
import { ConfirmationsService } from '../bookings/confirmations.service.js';
import { WaitlistService } from '../bookings/waitlist.service.js';
import { OperationalAutomations } from '../operations/automations.service.js';
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
      const clientSubscriptions=await app.get(ClientSubscriptionsService).reconcile();
        const confirmations=await app.get(ConfirmationsService).due();
        const waitlist=await app.get(WaitlistService).match();
        const operational = await app.get(OperationalAutomations).due();
      const temporal = await app.get(CommunicationEngine).temporal();
      const inbox = await app.get(NotificationsService).ingest();
      console.log(
        JSON.stringify({ commercial, temporal, operational, waitlist, confirmations, clientSubscriptions, inbox, inboxCleanup }),
      );
    } finally {
      await app.close();
    }
  } catch {
    console.error('COMMUNICATION_SCHEDULER_FAILED');
    process.exitCode = 1;
  }
}
