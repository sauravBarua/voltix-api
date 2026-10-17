import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SkipRateLimit } from '../rate-limit/rate-limit.decorator';
import { RedisService } from '../redis/redis.service';

@SkipRateLimit()
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  // Liveness: process is up (no dependencies)
  @Get()
  check() {
    return {
      status: 'ok',
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  // Readiness: only the database decides. Redis is an optimisation, so its state is informational.
  @Get('ready')
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException({ status: 'unavailable', db: 'down' });
    }
    return { status: 'ready', db: 'up', redis: (await this.redis.ping()) ? 'up' : 'down' };
  }
}
