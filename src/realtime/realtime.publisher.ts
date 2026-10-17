import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { REALTIME_CHANNEL } from './realtime.constants';
import type { RealtimeMessage } from './realtime.messages';

@Injectable()
export class RealtimePublisher {
  constructor(private readonly redis: RedisService) {}

  /** Rejects when Redis is unreachable on purpose, so the consumer retries. */
  async publish(message: RealtimeMessage): Promise<void> {
    await this.redis.client.publish(REALTIME_CHANNEL, JSON.stringify(message));
  }
}
