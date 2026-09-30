import { adminList } from '../common/admin-list.js';
import { GoogleApi } from './google-api.js';
import { GmailTransport } from './gmail.js';
import { GlobalPush } from './push.js';
import { GmailController, PushController } from './phase3.controller.js';
import { MetaWebhook, MetaWebhookController } from './meta-webhook.js';
import { MetaTemplates } from './meta.js';
import {
  Body,
  Controller,
  Get,
  Inject,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from '../common/admin.guard.js';
import type { AuthRequest } from '../auth/auth.types.js';
import { AuthRateLimit } from '../auth/auth-rate-limit.service.js';
import { SecretVault } from '../billing/secret-vault.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CommunicationConfiguration } from './configuration.js';
import { CommunicationEngine } from './engine.js';
import { CommunicationTransports } from './transports.js';
import { EVENTS, variablesFor } from './contracts.js';
@Controller('communication')
@UseGuards(AdminGuard)
export class CommunicationController {
  constructor(
    @Inject(MetaTemplates) private readonly meta: MetaTemplates,
    @Inject(CommunicationConfiguration)
    private readonly config: CommunicationConfiguration,
    @Inject(CommunicationEngine) private readonly engine: CommunicationEngine,
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(AuthRateLimit) private readonly limit: AuthRateLimit,
  ) {}
  @Get('providers') providers() {
    return this.config.list();
  }
  @Patch('providers/:provider') patch(
    @Param('provider') provider: string,
    @Body() body: unknown,
    @Req() req: AuthRequest,
  ) {
    return this.config.patch(provider, body, req.auth.user.id);
  }
  @Post('providers/:provider/test') async test(
    @Param('provider') provider: string,
    @Req() req: AuthRequest,
  ) {
    await this.limit.consume('communication-test', req.auth.user.id, 5, 300);
    await this.limit.consume('communication-test-global', 'GLOBAL', 20, 300);
    return this.config.test(provider, req.auth.user.id);
  }
  @Post('providers/:provider/send-test') async sendTest(
    @Param('provider') provider: string,
    @Body() body: unknown,
    @Req() req: AuthRequest,
  ) {
    await this.limit.consume('communication-test', req.auth.user.id, 5, 300);
    await this.limit.consume('communication-test-global', 'GLOBAL', 20, 300);
    return this.config.sendTest(provider, body, req.auth.user.id);
  }
  @Post('providers/EVOLUTION/pair') async pair(@Req() req: AuthRequest) {
    await this.limit.consume('communication-test', req.auth.user.id, 5, 300);
    await this.limit.consume('communication-test-global', 'GLOBAL', 20, 300);
    return this.config.pairEvolution(req.auth.user.id);
  }
  @Get('meta/templates') metaList() {
    return this.meta.list();
  }
  @Post('meta/templates/sync') async metaSync(
    @Body() body: unknown,
    @Req() req: AuthRequest,
  ) {
    await this.limit.consume('communication-meta', req.auth.user.id, 10, 300);
    return this.meta.sync(body, req.auth.user.id);
  }
  @Post('meta/templates') async metaCreate(
    @Body() body: unknown,
    @Req() req: AuthRequest,
  ) {
    await this.limit.consume('communication-meta', req.auth.user.id, 10, 300);
    return this.meta.create(body, req.auth.user.id);
  }
  @Get('events') events() {
    return EVENTS.map((event) => ({ event, variables: variablesFor(event) }));
  }
  @Get('templates') templates() {
    return this.db.globalCommunicationTemplate.findMany({
      take: 100,
      orderBy: [{ event: 'asc' }, { channel: 'asc' }],
    });
  }
  @Patch('templates/:event/:channel') template(
    @Param('event') event: string,
    @Param('channel') channel: string,
    @Body() body: unknown,
    @Req() req: AuthRequest,
  ) {
    return this.engine.template(event, channel, body, req.auth.user.id);
  }
  @Get('outbox') outbox(@Query() query: Record<string, string> = {}) {
    const page = adminList(query, []);
    return this.db.globalCommunicationOutbox.findMany({
      take: page.take,
      skip: page.skip,
      where: { scope: 'GLOBAL' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      omit: { variables: true },
    });
  }
  @Get('deliveries') deliveries(@Query() query: Record<string, string> = {}) {
    return this.engine.listDeliveries({}, query);
  }
  @Get('failures') failures(@Query() query: Record<string, string> = {}) {
    return this.engine.listDeliveries(
      {
        status: { in: ['FAILED', 'UNSENDABLE', 'UNCERTAIN'] },
      },
      query,
    );
  }
  @Get('logs') logs(@Query() query: Record<string, string> = {}) {
    const page = adminList(query, []);
    return this.db.globalCommunicationLog.findMany({
      take: page.take,
      skip: page.skip,
      where: { scope: 'GLOBAL' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }
  @Post('deliveries/:id/reprocess') async reprocess(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: AuthRequest,
  ) {
    await this.limit.consume('communication-retry', req.auth.user.id, 10, 300);
    return this.engine.reprocess(id, req.auth.user.id);
  }
}
@Module({
  controllers: [
    CommunicationController,
    MetaWebhookController,
    GmailController,
    PushController,
  ],
  providers: [
    GoogleApi,
    GmailTransport,
    GlobalPush,
    MetaTemplates,
    MetaWebhook,
    CommunicationConfiguration,
    CommunicationEngine,
    CommunicationTransports,
    SecretVault,
    AuthRateLimit,
  ],
  exports: [CommunicationEngine],
})
export class CommunicationModule {}
