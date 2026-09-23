import { Module } from '@nestjs/common';
import { PlansService } from './plans.service.js';
import { PlansController } from './plans.controller.js';

@Module({
  providers: [PlansService],
  controllers: [PlansController]
})
export class PlansModule {}
