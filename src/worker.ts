import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  // No HTTP server: the open RabbitMQ connection and the publisher loop keep the process alive
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
}

void bootstrap();
