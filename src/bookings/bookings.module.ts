import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { PublicBookingsController, TenantBookingsController } from './bookings.controller.js';
import { BookingsService } from './bookings.service.js';

@Module({
  imports: [AuthModule, BillingModule],
  controllers: [PublicBookingsController, TenantBookingsController],
  providers: [BookingsService],
})
export class BookingsModule {}
