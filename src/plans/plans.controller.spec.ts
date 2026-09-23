import { AdminGuard } from '../common/admin.guard.js';
import { PlansService } from './plans.service.js';
import { Test, TestingModule } from '@nestjs/testing';
import { PlansController } from './plans.controller.js';

describe('PlansController', () => {
  let controller: PlansController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PlansController],
      providers: [{ provide: PlansService, useValue: {} }],
    })
      .overrideGuard(AdminGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<PlansController>(PlansController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
