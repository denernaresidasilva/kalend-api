import {
  Body,
  Controller,
  Get,
  Inject,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard.js';
import type { AuthRequest } from '../auth/auth.types.js';
import { NotificationsService } from './notifications.service.js';
import { object } from '../common/validation.js';
@Controller('notifications')
@UseGuards(AuthGuard)
export class NotificationsController {
  constructor(
    @Inject(NotificationsService)
    private readonly service: NotificationsService,
  ) {}
  @Get('unread-count') count(@Req() req: AuthRequest) {
    return this.service.count(req.auth);
  }
  @Get() list(@Req() req: AuthRequest, @Query() query: Record<string, string>) {
    return this.service.list(req.auth, query);
  }
  @Post('read-all') readAll(@Req() req: AuthRequest, @Body() body: unknown) {
    object(body ?? {}, []);
    return this.service.read(req.auth);
  }
  @Post(':id/read') read(
    @Req() req: AuthRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ) {
    object(body ?? {}, []);
    return this.service.read(req.auth, id);
  }
  @Get('preferences') preferences(@Req() req: AuthRequest) {
    return this.service.preferences(req.auth);
  }
  @Put('preferences') setPreferences(
    @Req() req: AuthRequest,
    @Body() body: unknown,
  ) {
    return this.service.setPreferences(req.auth, body);
  }
}
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
