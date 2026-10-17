import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { RedisService } from '../src/redis/redis.service';

describe('Redis (e2e)', () => {
  let redis: RedisService;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    close = () => app.close();
    redis = app.get(RedisService);
    for (let i = 0; i < 50 && !(await redis.ping()); i++)
      await new Promise((r) => setTimeout(r, 100));
  });

  afterAll(async () => {
    await close();
  });

  it('answers ping', async () => {
    expect(await redis.ping()).toBe(true);
  });

  it('round-trips a value', async () => {
    const key = 'e2e:redis:roundtrip';
    await redis.client.set(key, 'ok', 'EX', 10);
    expect(await redis.client.get(key)).toBe('ok');
    await redis.client.del(key);
  });
});
