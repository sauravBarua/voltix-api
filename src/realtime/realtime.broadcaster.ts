import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { RedisService } from '../redis/redis.service';
import { REALTIME_CHANNEL } from './realtime.constants';
import { RealtimeGateway } from './realtime.gateway';
import { realtimeMessageSchema } from './realtime.messages';

/** API side: every API instance gets every message and emits to its own local sockets. */
@Injectable()
export class RealtimeBroadcaster implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RealtimeBroadcaster.name);
  private subscriber: Redis | null = null;

  constructor(
    private readonly redis: RedisService,
    private readonly gateway: RealtimeGateway,
  ) {}

  onModuleInit() {
    const subscriber = this.redis.createSubscriber();
    this.subscriber = subscriber;
    subscriber.on('error', (error: Error) => this.redis.logThrottled(error));
    subscriber.on('message', (_channel: string, raw: string) => this.dispatch(raw));
    // Not awaited: the API starts even if Redis is down, ioredis subscribes (and resubscribes) once it is up
    subscriber
      .subscribe(REALTIME_CHANNEL)
      .catch((error: unknown) => this.redis.logThrottled(error));
  }

  async onApplicationShutdown() {
    try {
      await this.subscriber?.quit();
    } catch {
      this.subscriber?.disconnect();
    }
  }

  private dispatch(raw: string) {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.logger.warn('Ignoring a realtime message that is not JSON');
      return;
    }
    const parsed = realtimeMessageSchema.safeParse(json);
    if (!parsed.success) {
      this.logger.warn('Ignoring a malformed realtime message');
      return;
    }
    const { rooms, event, data } = parsed.data;
    this.gateway.server?.to(rooms).emit(event, data);
  }
}
