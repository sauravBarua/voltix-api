import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { RedisService } from '../redis/redis.service';
import {
  RATE_LIMIT_OPTIONS,
  RATE_LIMIT_POLICIES,
  type RateLimitOptions,
  type RateLimitPolicyName,
} from './rate-limit.constants';
import { RATE_LIMIT_KEY } from './rate-limit.decorator';

// Atomic fixed window: count the hit, start the window on the first one, return the time left.
const SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end
return {count, ttl}
`;

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
    @Inject(RATE_LIMIT_OPTIONS) private readonly options: RateLimitOptions,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.options.enabled || context.getType() !== 'http') return true;

    const setting = this.reflector.getAllAndOverride<RateLimitPolicyName | 'skip' | undefined>(
      RATE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (setting === 'skip') return true;

    const name = setting ?? 'default';
    const policy = RATE_LIMIT_POLICIES[name];
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    const key = `rl:${name}:${req.ip ?? 'unknown'}`;

    let count: number;
    let ttlMs: number;
    try {
      const reply = (await this.redis.client.eval(
        SCRIPT,
        1,
        key,
        String(policy.windowSeconds * 1000),
      )) as [number, number];
      [count, ttlMs] = reply;
    } catch (error) {
      this.redis.logThrottled(error);
      return true; // fail open: an outage of the limiter must not take the API down
    }

    const resetSeconds = Math.max(1, Math.ceil(ttlMs / 1000));
    res.setHeader('RateLimit-Limit', policy.limit);
    res.setHeader('RateLimit-Remaining', Math.max(0, policy.limit - count));
    res.setHeader('RateLimit-Reset', resetSeconds);

    if (count > policy.limit) {
      res.setHeader('Retry-After', resetSeconds);
      throw new HttpException(
        {
          statusCode: 429,
          error: 'Too Many Requests',
          message: 'Too many requests, slow down',
          retryAfterSeconds: resetSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
