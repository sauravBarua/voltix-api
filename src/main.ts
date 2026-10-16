import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import { AppModule } from './app.module';
import type { Env } from './config/env';

async function bootstrap() {
  // rawBody: true is needed for Stripe webhook signature verification (Phase 10)
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.enableShutdownHooks();

  const config = app.get<ConfigService<Env, true>>(ConfigService);

  if (config.get('NODE_ENV', { infer: true }) !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Voltix API')
      .setDescription('Voltix electronics store backend')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();
    // UI at /docs, raw spec at /docs-json (used by openapi-typescript in Phase 20)
    SwaggerModule.setup(
      'docs',
      app,
      cleanupOpenApiDoc(SwaggerModule.createDocument(app, swaggerConfig)),
    );
  }

  await app.listen(config.get('PORT', { infer: true }));
}

void bootstrap();
