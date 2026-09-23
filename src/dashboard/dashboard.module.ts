import { Inject } from '@nestjs/common';
import { Controller, Get, Module, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../common/admin.guard.js';
import { DashboardService } from './dashboard.service.js';
@Controller('dashboard')
@UseGuards(AdminGuard)
export class DashboardController {
  constructor(
    @Inject(DashboardService) private readonly service: DashboardService,
  ) {}
  @Get('summary') summary() {
    return this.service.summary();
  }
}
@Module({ controllers: [DashboardController], providers: [DashboardService] })
export class DashboardModule {}
