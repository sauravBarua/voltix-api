import { Module } from '@nestjs/common';
import { ConsumerRunner } from './consumer.runner';
import { RabbitMqService } from './rabbitmq.service';

@Module({
  providers: [RabbitMqService, ConsumerRunner],
  exports: [RabbitMqService, ConsumerRunner],
})
export class MessagingModule {}
