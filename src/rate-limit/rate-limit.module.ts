import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import type { Env } from '../config/env';
import { RATE_LIMIT_OPTIONS, type RateLimitOptions } from './rate-limit.constants';
import { RateLimitGuard } from './rate-limit.guard';

@Module({
  providers: [
    {
      provide: RATE_LIMIT_OPTIONS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): RateLimitOptions => ({
        enabled:
          config.get('RATE_LIMIT_ENABLED', { infer: true }) ??
          config.get('NODE_ENV', { infer: true }) !== 'test',
      }),
    },
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
})
export class RateLimitModule {}
