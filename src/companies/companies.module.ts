import { CommunicationModule } from '../communication/communication.module.js';
import { Module } from '@nestjs/common';
import { CompaniesController } from './companies.controller.js';
import { CompaniesService } from './companies.service.js';

@Module({
  imports: [CommunicationModule],
  controllers: [CompaniesController],
  providers: [CompaniesService],
})
export class CompaniesModule {}
