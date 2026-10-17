import { Module } from '@nestjs/common';
import { OutboxAdminController } from './outbox-admin.controller';
import { OutboxAdminService } from './outbox-admin.service';

@Module({ controllers: [OutboxAdminController], providers: [OutboxAdminService] })
export class OutboxModule {}
