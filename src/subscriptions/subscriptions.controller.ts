import {
  Controller,
  Get,
  NotFoundException,
  Param,
} from '@nestjs/common';

import { SubscriptionsService } from './subscriptions.service.js';

@Controller('subscriptions')
export class SubscriptionsController {
  constructor(
    private readonly subscriptionsService: SubscriptionsService,
  ) {}

  @Get()
  async findAll() {
    return this.subscriptionsService.findAll();
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    const subscription =
      await this.subscriptionsService.findOne(id);

    if (!subscription) {
      throw new NotFoundException(
        'Assinatura não encontrada.',
      );
    }

    return subscription;
  }
}

