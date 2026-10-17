import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from './redis.service';

const TTL_SECONDS = 30; // safety net: normally the inventory.changed event invalidates within ~1-2 s
const key = (variantId: string) => `cache:avail:${variantId}`;

/**
 * Read-only projection of `on_hand - reserved` per variant, for display. It is NEVER used to decide
 * anything: carts, checkout and reservations read Postgres.
 */
@Injectable()
export class AvailabilityService {
  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
  ) {}

  async getMany(variantIds: string[]): Promise<Map<string, number>> {
    const ids = [...new Set(variantIds)];
    const result = new Map<string, number>();
    if (ids.length === 0) return result;

    let cached: (string | null)[] = ids.map(() => null);
    try {
      cached = await this.redis.client.mget(ids.map(key));
    } catch (error) {
      this.redis.logThrottled(error);
    }

    const missing: string[] = [];
    ids.forEach((id, i) => {
      const raw = cached[i];
      const n = raw === null || raw === undefined ? Number.NaN : Number(raw);
      if (Number.isInteger(n) && n >= 0) result.set(id, n);
      else missing.push(id);
    });
    if (missing.length === 0) return result;

    // One query for every miss
    const rows = await this.prisma.inventoryItem.findMany({
      where: { variantId: { in: missing } },
      select: { variantId: true, onHand: true, reserved: true },
    });
    const loaded = new Map(rows.map((r) => [r.variantId, Math.max(0, r.onHand - r.reserved)]));

    const pipeline = this.redis.client.pipeline();
    for (const id of missing) {
      const value = loaded.get(id) ?? 0;
      result.set(id, value);
      pipeline.set(key(id), String(value), 'EX', TTL_SECONDS);
    }
    try {
      await pipeline.exec();
    } catch (error) {
      this.redis.logThrottled(error);
    }
    return result;
  }

  /**
   * Throws when Redis is unreachable ON PURPOSE: the consumer retries (5 s, 30 s, 5 min) and the
   * TTL is the last backstop. Silently ignoring it would leave stale stock on screen.
   */
  async invalidate(variantIds: string[]): Promise<void> {
    if (variantIds.length === 0) return;
    await this.redis.client.del(...variantIds.map(key));
  }
}
