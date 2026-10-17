import { Injectable } from '@nestjs/common';
import { RedisService } from './redis.service';

/** Cache-aside with fail-open reads, single-flight loading and TTL jitter. */
@Injectable()
export class CacheService {
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(private readonly redis: RedisService) {}

  async getOrSet<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
    const cached = await this.read<T>(key);
    if (cached !== undefined) return cached;

    // Concurrent misses in this process share one load (protects the database on a cold or hot key)
    const pending = this.inflight.get(key) as Promise<T> | undefined;
    if (pending) return pending;

    const promise = this.load(key, ttlSeconds, loader).finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  private async read<T>(key: string): Promise<T | undefined> {
    try {
      const raw = await this.redis.client.get(key);
      return raw === null ? undefined : (JSON.parse(raw) as T);
    } catch (error) {
      this.redis.logThrottled(error); // Redis down or corrupt value: behave like a miss
      return undefined;
    }
  }

  private async load<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
    const value = await loader(); // loader errors propagate and nothing is cached
    const ttl = Math.max(1, Math.round(ttlSeconds * (0.9 + Math.random() * 0.2))); // +-10% so keys do not expire together
    try {
      await this.redis.client.set(key, JSON.stringify(value), 'EX', ttl);
    } catch (error) {
      this.redis.logThrottled(error);
    }
    return value;
  }
}
