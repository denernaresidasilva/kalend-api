import { Body, Delete, Patch, Query } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { AdminGuard } from '../common/admin.guard.js';
import { Controller, Get, NotFoundException, Param } from '@nestjs/common';

import { UsersService } from './users.service.js';

@UseGuards(AdminGuard)
@Controller('users')
export class UsersController {
  constructor(
    @Inject(UsersService) private readonly usersService: UsersService,
  ) {}

  @Get()
  async findAll(@Query() query: Record<string, string> = {}) {
    return this.usersService.findAll(query);
  }

  @Get('summary')
  async summary() {
    return this.usersService.summary();
  }

  @Get(':id')
  async findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    const user = await this.usersService.findOne(id);

    if (!user) {
      throw new NotFoundException('Usuário não encontrado.');
    }

    return user;
  }

  @Patch(':id')
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ) {
    return this.usersService.update(id, body);
  }

  @Delete(':id')
  async remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ) {
    return this.usersService.remove(id, body);
  }
}
