import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import type { Env } from './config/env';

async function bootstrap() {
  // rawBody: true is needed for Stripe webhook signature verification
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  configureApp(app);

  const config = app.get<ConfigService<Env, true>>(ConfigService);

  // Behind a reverse proxy, req.ip (used by the rate limiter) is only correct when Express trusts it
  const hops = config.get('TRUST_PROXY_HOPS', { infer: true });
  if (hops > 0) app.set('trust proxy', hops);

  if (config.get('NODE_ENV', { infer: true }) !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Voltix API')
      .setDescription('Voltix electronics store backend')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup(
      'docs',
      app,
      cleanupOpenApiDoc(SwaggerModule.createDocument(app, swaggerConfig)),
    );
  }

  await app.listen(config.get('PORT', { infer: true }));
}

void bootstrap();
