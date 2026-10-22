import type { AuthRequest } from '../auth/auth.types.js';
import { Req } from '@nestjs/common';
import { Query } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { AdminGuard } from '../common/admin.guard.js';
import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';

import { CompaniesService } from './companies.service.js';

@UseGuards(AdminGuard)
@Controller('companies')
export class CompaniesController {
  constructor(
    @Inject(CompaniesService)
    private readonly companiesService: CompaniesService,
  ) {}

  @Post('manual')
  async createManual(
    @Req() req: AuthRequest,
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
      adminGraceDays?: number;
    },
  ) {
    return this.companiesService.createManual(body, req.auth.user.id);
  }

  @Post(':id/entitlements/:entitlementId/revoke')
  revokeAdministrativeGrant(
    @Req() req: AuthRequest,
    @Param('id', new ParseUUIDPipe()) companyId: string,
    @Param('entitlementId', new ParseUUIDPipe()) entitlementId: string,
  ) {
    return this.companiesService.revokeAdministrativeGrant(companyId, entitlementId, req.auth.user.id);
  }

  @Get()
  async findAll(@Query() query: Record<string, string> = {}) {
    return this.companiesService.findAll(query);
  }

  @Get(':id')
  async findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    const company = await this.companiesService.findOne(id);

    if (!company) {
      throw new NotFoundException('Empresa não encontrada.');
    }

    return company;
  }

  @Patch(':id')
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ) {
    return this.companiesService.update(id, body);
  }

  @Delete(':id')
  async remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ) {
    return this.companiesService.remove(id, body);
  }
}
