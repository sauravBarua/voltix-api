import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env';
import { JobsModule } from './jobs/jobs.module';
import { MessagingModule } from './messaging/messaging.module';
import { NotificationsModule } from './notifications/notifications.module';
import { OutboxPublisherModule } from './outbox/outbox-publisher.module';
import { PrismaModule } from './prisma/prisma.module';
import { RealtimeWorkerModule } from './realtime/realtime-worker.module';
import { CacheInvalidationModule } from './redis/cache-invalidation.module';
import { RedisModule } from './redis/redis.module';

// Same .env as the API: the schema validates every variable, so the worker needs them too
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    PrismaModule,
    RedisModule,
    MessagingModule,
    OutboxPublisherModule,
    NotificationsModule,
    CacheInvalidationModule,
    RealtimeWorkerModule,
    JobsModule,
  ],
})
export class WorkerModule {}
