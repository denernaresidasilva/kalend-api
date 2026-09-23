import {
  Controller,
  Get,
  NotFoundException,
  Param,
} from '@nestjs/common';
import { WebhooksService } from './webhooks.service.js';

@Controller('webhooks')
export class WebhooksController {
  constructor(
    private readonly webhooksService: WebhooksService,
  ) {}

  @Get()
  async findAll() {
    return this.webhooksService.findAll();
  }

  @Get('summary')
  async summary() {
    return this.webhooksService.summary();
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    const event = await this.webhooksService.findOne(id);

    if (!event) {
      throw new NotFoundException(
        'Evento de webhook não encontrado.',
      );
    }

    return event;
  }
}

