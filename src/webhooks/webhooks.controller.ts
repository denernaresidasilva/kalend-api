import { Inject } from '@nestjs/common';
import { UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { AdminGuard } from '../common/admin.guard.js';
import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { WebhooksService } from './webhooks.service.js';

@UseGuards(AdminGuard)
@Controller('webhooks')
export class WebhooksController {
  constructor(
    @Inject(WebhooksService) private readonly webhooksService: WebhooksService,
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
  async findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    const event = await this.webhooksService.findOne(id);

    if (!event) {
      throw new NotFoundException('Evento de webhook não encontrado.');
    }

    return event;
  }
}
