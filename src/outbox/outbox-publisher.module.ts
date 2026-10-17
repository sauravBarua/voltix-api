import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module';
import { OutboxPublisher } from './outbox.publisher';

@Module({ imports: [MessagingModule], providers: [OutboxPublisher] })
export class OutboxPublisherModule {}
