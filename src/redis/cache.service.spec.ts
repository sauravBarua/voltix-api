import { CacheService } from './cache.service';
import type { RedisService } from './redis.service';

function setup() {
  const get = jest.fn();
  const set = jest.fn().mockResolvedValue('OK');
  const logThrottled = jest.fn();
  const redis = { client: { get, set }, logThrottled } as unknown as RedisService;
  return { cache: new CacheService(redis), get, set, logThrottled };
}

describe('CacheService.getOrSet', () => {
  it('returns the cached value without calling the loader', async () => {
    const { cache, get } = setup();
    get.mockResolvedValue(JSON.stringify({ a: 1 }));
    const loader = jest.fn().mockResolvedValue({ a: 2 });
    await expect(cache.getOrSet('k', 60, loader)).resolves.toEqual({ a: 1 });
    expect(loader).not.toHaveBeenCalled();
  });

  it('loads on a miss and stores the value with a jittered TTL', async () => {
    const { cache, get, set } = setup();
    get.mockResolvedValue(null);
    await expect(cache.getOrSet('k', 100, () => Promise.resolve({ a: 2 }))).resolves.toEqual({
      a: 2,
    });
    expect(set).toHaveBeenCalledWith('k', '{"a":2}', 'EX', expect.any(Number));
    const ttl = Number((set.mock.calls[0] as unknown[])[3]);
    expect(ttl).toBeGreaterThanOrEqual(90);
    expect(ttl).toBeLessThanOrEqual(110);
  });

  it('shares one load between concurrent callers', async () => {
    const { cache, get } = setup();
    get.mockResolvedValue(null);
    const loader = jest.fn(
      () => new Promise<{ v: number }>((resolve) => setTimeout(() => resolve({ v: 1 }), 20)),
    );
    const results = await Promise.all(
      Array.from({ length: 5 }, () => cache.getOrSet('k', 60, loader)),
    );
    expect(results).toEqual(Array.from({ length: 5 }, () => ({ v: 1 })));
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('falls back to the loader when Redis fails', async () => {
    const { cache, get, set, logThrottled } = setup();
    get.mockRejectedValue(new Error('down'));
    set.mockRejectedValue(new Error('down'));
    await expect(cache.getOrSet('k', 60, () => Promise.resolve('fresh'))).resolves.toBe('fresh');
    expect(logThrottled).toHaveBeenCalled();
  });

  it('treats a corrupt cached value as a miss', async () => {
    const { cache, get } = setup();
    get.mockResolvedValue('{not json');
    await expect(cache.getOrSet('k', 60, () => Promise.resolve('fresh'))).resolves.toBe('fresh');
  });

  it('does not cache a loader error', async () => {
    const { cache, get, set } = setup();
    get.mockResolvedValue(null);
    await expect(cache.getOrSet('k', 60, () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    expect(set).not.toHaveBeenCalled();
  });
});
