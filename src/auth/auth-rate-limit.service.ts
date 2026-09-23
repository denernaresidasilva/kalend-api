import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuthConfig } from './auth.config.js';
@Injectable()
export class AuthRateLimit {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthConfig) private readonly config: AuthConfig,
  ) {}
  async consume(
    scope: string,
    identity: string,
    limit: number,
    seconds: number,
  ) {
    const bucket = Math.floor(Date.now() / (seconds * 1000));
    const key = createHmac('sha256', this.config.key())
      .update(`rate-limit:${scope}:${bucket}:${identity}`)
      .digest('hex');
    // Atomic upsert: shared across replicas, including nonexistent accounts. No passwords or clear emails/IPs stored.
    const record = await this.prisma.authRateLimit.upsert({
      where: { key },
      create: {
        key,
        attempts: 1,
        expiresAt: new Date((bucket + 2) * seconds * 1000),
      },
      update: { attempts: { increment: 1 } },
      select: { attempts: true },
    });
    if (record.attempts > limit)
      throw new HttpException(
        'Muitas tentativas. Aguarde e tente novamente.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
  }
}
