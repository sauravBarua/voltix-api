import { Module } from '@nestjs/common';
import { RealtimeBroadcaster } from './realtime.broadcaster';
import { RealtimeGateway } from './realtime.gateway';

@Module({ providers: [RealtimeGateway, RealtimeBroadcaster] })
export class RealtimeModule {}
