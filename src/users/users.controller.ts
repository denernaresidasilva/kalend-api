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
  async findAll() {
    return this.usersService.findAll();
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
}
