import { Inject } from '@nestjs/common';
import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service.js';
import { PrismaService } from './prisma/prisma.service.js';

@Controller()
export class AppController {
  constructor(
    @Inject(AppService) private readonly appService: AppService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('health')
  async health() {
    await this.prisma.$queryRaw`SELECT 1`;

    return {
      status: 'ok',
      api: 'online',
      database: 'connected',
      timestamp: new Date().toISOString(),
    };
  }
}
