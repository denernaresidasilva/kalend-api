import { Inject } from '@nestjs/common';
import { UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { AdminGuard } from '../common/admin.guard.js';
import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { PlansService } from './plans.service.js';

@Controller('plans')
export class PlansController {
  constructor(
    @Inject(PlansService) private readonly plansService: PlansService,
  ) {}

  // Rota pública: futura tela comercial de planos
  @Get('public')
  findPublic() {
    return this.plansService.findPublic();
  }

  // Super Admin: lista todos os planos
  @UseGuards(AdminGuard)
  @Get()
  findAll() {
    return this.plansService.findAll();
  }

  // Super Admin: detalhes de um plano
  @UseGuards(AdminGuard)
  @Get(':id')
  findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.plansService.findOne(id);
  }

  // Super Admin: cria um plano
  @UseGuards(AdminGuard)
  @Post()
  create(@Body() data: any) {
    return this.plansService.create(data);
  }

  // Super Admin: edita um plano
  @UseGuards(AdminGuard)
  @Patch(':id')
  update(@Param('id', new ParseUUIDPipe()) id: string, @Body() data: any) {
    return this.plansService.update(id, data);
  }

  // Super Admin: desativa sem apagar histórico
  @UseGuards(AdminGuard)
  @Patch(':id/deactivate')
  deactivate(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.plansService.deactivate(id);
  }
}
