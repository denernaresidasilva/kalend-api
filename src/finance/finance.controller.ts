import { Controller, Get } from '@nestjs/common';
import { FinanceService } from './finance.service.js';

@Controller('finance')
export class FinanceController {
  constructor(
    private readonly financeService: FinanceService,
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
