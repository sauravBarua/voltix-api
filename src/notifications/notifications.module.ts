import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module';
import { NotificationsConsumer } from './notifications.consumer';

@Module({ imports: [MessagingModule], providers: [NotificationsConsumer] })
export class NotificationsModule {}
