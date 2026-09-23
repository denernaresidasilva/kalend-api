import { Inject } from '@nestjs/common';
import { UseGuards } from '@nestjs/common';
import { AdminGuard } from '../common/admin.guard.js';
import { Controller, Get } from '@nestjs/common';
import { FinanceService } from './finance.service.js';

@UseGuards(AdminGuard)
@Controller('finance')
export class FinanceController {
  constructor(
    @Inject(FinanceService) private readonly financeService: FinanceService,
  ) {}

  @Get()
  async findAll() {
    return this.financeService.findAll();
  }

  @Get('summary')
  async summary() {
    return this.financeService.summary();
  }
}
