import { Inject } from '@nestjs/common';
import { UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { AdminGuard } from '../common/admin.guard.js';
import { Controller, Get, NotFoundException, Param } from '@nestjs/common';

import { SubscriptionsService } from './subscriptions.service.js';

@UseGuards(AdminGuard)
@Controller('subscriptions')
export class SubscriptionsController {
  constructor(
    @Inject(SubscriptionsService)
    private readonly subscriptionsService: SubscriptionsService,
  ) {}

  @Get()
  async findAll() {
    return this.subscriptionsService.findAll();
  }

  @Get(':id')
  async findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    const subscription = await this.subscriptionsService.findOne(id);

    if (!subscription) {
      throw new NotFoundException('Assinatura não encontrada.');
    }

    return subscription;
  }
}
