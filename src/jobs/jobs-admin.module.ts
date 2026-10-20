import { Module } from '@nestjs/common';
import { JobsAdminController } from './jobs-admin.controller';
import { JobsAdminService } from './jobs-admin.service';

@Module({ controllers: [JobsAdminController], providers: [JobsAdminService] })
export class JobsAdminModule {}
