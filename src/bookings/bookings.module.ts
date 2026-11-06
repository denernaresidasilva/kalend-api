import { WaitlistService } from './waitlist.service.js';
import { OperationsModule } from '../operations/operations.module.js';
import { PublicWaitlistController,TenantWaitlistController,BookingCancellationController } from './waitlist.controller.js';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { PublicBookingsController, TenantBookingsController } from './bookings.controller.js';
import { BookingEventsService } from './booking-events.service.js';
import { CustomerAccessService } from './customer-access.service.js';
import { BookingsService } from './bookings.service.js';

@Module({
  imports: [AuthModule, BillingModule, OperationsModule],
  controllers: [PublicWaitlistController,TenantWaitlistController,BookingCancellationController,PublicBookingsController, TenantBookingsController],
  providers: [WaitlistService, BookingsService, BookingEventsService, CustomerAccessService],
  exports:[WaitlistService],
})
export class BookingsModule {}
