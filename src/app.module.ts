import { AuthModule } from './auth/auth.module.js';
import { DashboardModule } from './dashboard/dashboard.module.js';
import { BillingModule } from './billing/billing.module.js';
import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { PlansModule } from './plans/plans.module.js';
import { CompaniesModule } from './companies/companies.module.js';
import { SubscriptionsModule } from './subscriptions/subscriptions.module.js';
import { FinanceModule } from './finance/finance.module.js';
import { WebhooksModule } from './webhooks/webhooks.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    DashboardModule,
    BillingModule,
    PlansModule,
    CompaniesModule,
    SubscriptionsModule,
    FinanceModule,
    WebhooksModule,
    UsersModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
