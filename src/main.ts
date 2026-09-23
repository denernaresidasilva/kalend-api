import { AuthConfig } from './auth/auth.config.js';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });

  const authConfig = app.get(AuthConfig);
  const proxies = authConfig.trustedProxies();
  app
    .getHttpAdapter()
    .getInstance()
    .set('trust proxy', proxies.length ? proxies : false);
  app.enableCors({
    origin: authConfig.origins(),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  });

  await app.listen(process.env.PORT ?? 3001);
}

await bootstrap();
