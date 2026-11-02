import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { PublicBookingsController, TenantBookingsController } from './bookings.controller.js';
import { BookingEventsService } from './booking-events.service.js';
import { CustomerAccessService } from './customer-access.service.js';
import { BookingsService } from './bookings.service.js';

@Module({
  imports: [AuthModule, BillingModule],
  controllers: [PublicBookingsController, TenantBookingsController],
  providers: [BookingsService, BookingEventsService, CustomerAccessService],
})
export class BookingsModule {}
