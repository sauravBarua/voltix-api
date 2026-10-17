import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module';
import { CacheInvalidationConsumer } from './cache-invalidation.consumer';

@Module({ imports: [MessagingModule], providers: [CacheInvalidationConsumer] })
export class CacheInvalidationModule {}
