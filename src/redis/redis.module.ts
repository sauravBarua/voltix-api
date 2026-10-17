import { Global, Module } from '@nestjs/common';
import { AvailabilityService } from './availability.service';
import { CacheService } from './cache.service';
import { RedisService } from './redis.service';

@Global()
@Module({
  providers: [RedisService, CacheService, AvailabilityService],
  exports: [RedisService, CacheService, AvailabilityService],
})
export class RedisModule {}
