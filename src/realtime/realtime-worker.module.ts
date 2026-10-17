import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module';
import { RealtimeConsumer } from './realtime.consumer';
import { RealtimePublisher } from './realtime.publisher';

@Module({ imports: [MessagingModule], providers: [RealtimePublisher, RealtimeConsumer] })
export class RealtimeWorkerModule {}
