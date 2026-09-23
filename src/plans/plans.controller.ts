import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { PlansService } from './plans.service.js';

@Controller('plans')
export class PlansController {
  constructor(private readonly plansService: PlansService) {}

  // Rota pública: futura tela comercial de planos
  @Get('public')
  findPublic() {
    return this.plansService.findPublic();
  }

  // Super Admin: lista todos os planos
  @Get()
  findAll() {
    return this.plansService.findAll();
  }

  // Super Admin: detalhes de um plano
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.plansService.findOne(id);
  }

  // Super Admin: cria um plano
  @Post()
  create(@Body() data: any) {
    return this.plansService.create(data);
  }

  // Super Admin: edita um plano
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() data: any,
  ) {
    return this.plansService.update(id, data);
  }

  // Super Admin: desativa sem apagar histórico
  @Patch(':id/deactivate')
  deactivate(@Param('id') id: string) {
    return this.plansService.deactivate(id);
  }
}
