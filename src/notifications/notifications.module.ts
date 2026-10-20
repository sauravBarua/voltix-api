import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module';
import { MessagingModule } from '../messaging/messaging.module';
import { PaymentsModule } from '../payments/payments.module';
import { NotificationsConsumer } from './notifications.consumer';

@Module({
  imports: [MessagingModule, MailModule, PaymentsModule],
  providers: [NotificationsConsumer],
})
export class NotificationsModule {}
