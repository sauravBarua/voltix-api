import { Injectable, OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import { ConsumerRunner } from '../messaging/consumer.runner';
import { PoisonMessageError } from '../messaging/envelope';
import { AvailabilityService } from './availability.service';

const payloadSchema = z.object({ variantIds: z.array(z.string()).max(1000) });

/** Worker-side: drops the cached availability of the variants whose stock just changed (committed). */
@Injectable()
export class CacheInvalidationConsumer implements OnModuleInit {
  constructor(
    private readonly runner: ConsumerRunner,
    private readonly availability: AvailabilityService,
  ) {}

  onModuleInit() {
    return this.runner.register({
      name: 'cache-invalidation',
      routingKeys: ['inventory.changed'],
      prefetch: 50,
      handle: async (event) => {
        const parsed = payloadSchema.safeParse(event.payload);
        if (!parsed.success) throw new PoisonMessageError('inventory.changed payload is invalid');
        await this.availability.invalidate(parsed.data.variantIds); // idempotent, throws on Redis errors -> retry
      },
    });
  }
}
