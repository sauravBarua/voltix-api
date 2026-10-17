import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import type { Env } from '../config/env';

const LOG_EVERY_MS = 30_000;

/** Fail-fast client: with Redis down, commands reject at once instead of queueing, so callers fall back. */
@Injectable()
export class RedisService implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisService.name);
  private lastLoggedAt = 0;
  readonly client: Redis;

  constructor(config: ConfigService<Env, true>) {
    this.client = new Redis(config.get('REDIS_URL', { infer: true }), {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2_000,
      commandTimeout: 1_000,
      retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
    });
    this.client.on('error', (error: Error) => this.logThrottled(error));
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  /** One line per 30 s, so an outage does not flood the logs. */
  logThrottled(error: unknown) {
    const now = Date.now();
    if (now - this.lastLoggedAt < LOG_EVERY_MS) return;
    this.lastLoggedAt = now;
    this.logger.warn(
      `Redis unavailable, continuing without cache: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  async onApplicationShutdown() {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}
