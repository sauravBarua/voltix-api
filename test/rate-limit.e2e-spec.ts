import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { RATE_LIMIT_OPTIONS } from '../src/rate-limit/rate-limit.constants';
import { RedisService } from '../src/redis/redis.service';

describe('Rate limiting (e2e)', () => {
  let app: INestApplication<App>;
  let redis: RedisService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RATE_LIMIT_OPTIONS)
      .useValue({ enabled: true }) // off by default under NODE_ENV=test
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    redis = app.get(RedisService);
    for (let i = 0; i < 50 && !(await redis.ping()); i++)
      await new Promise((r) => setTimeout(r, 100));
  });

  const clear = async () => {
    const keys = await redis.client.keys('rl:*');
    if (keys.length) await redis.client.del(...keys);
  };
  beforeEach(clear);
  afterAll(async () => {
    await clear();
    await app.close();
  });

  const server = () => app.getHttpServer();
  const checkout = () => request(server()).post('/api/v1/orders/checkout').send({}); // 401 without a user: still counted

  it('limits the strict policy (checkout) at 10 per minute, with headers', async () => {
    const first = await checkout();
    expect(first.status).toBe(401);
    expect(first.headers['ratelimit-limit']).toBe('10');
    expect(first.headers['ratelimit-remaining']).toBe('9');

    for (let i = 2; i <= 10; i++) expect((await checkout()).status).toBe(401);
    const blocked = await checkout();
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.headers['ratelimit-remaining']).toBe('0');
    expect(blocked.body).toMatchObject({
      statusCode: 429,
      message: 'Too many requests, slow down',
    });
  });

  it('limits everything else at 120 per minute, and policies are counted separately', async () => {
    for (let i = 1; i <= 120; i++) {
      expect((await request(server()).get('/api/v1/categories')).status).toBe(200);
    }
    expect((await request(server()).get('/api/v1/categories')).status).toBe(429);
    expect((await checkout()).status).toBe(401); // the strict counter is untouched
  }, 30_000);

  it('never limits health probes or the Stripe webhook', async () => {
    for (let i = 0; i < 125; i++) {
      expect((await request(server()).post('/webhooks/stripe').send({})).status).toBe(400); // bad signature, never 429
    }
    for (let i = 0; i < 125; i++) expect((await request(server()).get('/health')).status).toBe(200);
  }, 30_000);

  it('fails open when Redis errors', async () => {
    const spy = jest.spyOn(redis.client, 'eval').mockRejectedValue(new Error('redis down'));
    try {
      expect((await request(server()).get('/api/v1/categories')).status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });
});
