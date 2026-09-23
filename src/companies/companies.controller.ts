import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';

import { CompaniesService } from './companies.service.js';

@Controller('companies')
export class CompaniesController {
  constructor(
    private readonly companiesService: CompaniesService,
  ) {}

  @Post('manual')
  async createManual(
    @Body()
    body: {
      companyName: string;
      slug: string;
      timezone?: string;

      ownerName: string;
      ownerEmail: string;
      ownerPhone?: string;
      ownerPassword: string;

      planId: string;
      billingInterval?: 'MONTHLY' | 'YEARLY';
      startWithTrial?: boolean;
    },
  ) {
    return this.companiesService.createManual(body);
  }

  @Get()
  async findAll() {
    return this.companiesService.findAll();
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    const company =
      await this.companiesService.findOne(id);

    if (!company) {
      throw new NotFoundException(
        'Empresa não encontrada.',
      );
    }

    return company;
  }
}
