import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import Stripe from 'stripe';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import type { Env } from '../src/config/env';
import { StripeService } from '../src/payments/stripe.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RATE_LIMIT_OPTIONS } from '../src/rate-limit/rate-limit.constants';
import { RedisService } from '../src/redis/redis.service';
import { ReservationsService } from '../src/reservations/reservations.service';
import { TestAuth } from './helpers/auth';
import { Shop } from './helpers/shop';
import { FakeStripe, stripeServiceValue } from './helpers/stripe-fake';

jest.setTimeout(60_000);

describe('Failure injection: Redis down, Stripe down, database down (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let reservations: ReservationsService;
  let auth: TestAuth;
  let shop: Shop;
  const fake = new FakeStripe();
  const placed: string[] = [];

  beforeAll(async () => {
    // A real Redis client pointed at a port nobody listens on: every command fails exactly like an outage
    const deadRedis = new RedisService({
      get: () => 'redis://127.0.0.1:1',
    } as unknown as ConfigService<Env, true>);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(StripeService)
      .useValue(stripeServiceValue(fake))
      .overrideProvider(RedisService)
      .useValue(deadRedis)
      .overrideProvider(RATE_LIMIT_OPTIONS)
      .useValue({ enabled: true }) // the limiter is on, and its backing store is down
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    reservations = app.get(ReservationsService);
    auth = await TestAuth.create(app);
    shop = await Shop.create(auth);
  });

  afterAll(async () => {
    for (const id of placed) {
      await prisma.$transaction(async (tx) => {
        await reservations.release(tx, id);
        await tx.order.updateMany({
          where: { id, status: 'PENDING_PAYMENT' },
          data: { status: 'CANCELLED', cancelReason: 'TEST_CLEANUP', cancelledAt: new Date() },
        });
      });
    }
    await app.close();
  });

  it('keeps serving: readiness reports redis down, catalog reads come from Postgres with live stock', async () => {
    const ready = await request(app.getHttpServer()).get('/health/ready').expect(200);
    expect(ready.body).toEqual({ status: 'ready', db: 'up', redis: 'down' });

    const variant = await shop.variant(5); // the write succeeds although it cannot invalidate any cache
    const product = await prisma.product.findFirstOrThrow({
      where: { variants: { some: { id: variant } } },
      select: { slug: true },
    });
    const detail = (await auth.api('anon').get(`/products/${product.slug}`).expect(200)).body as {
      inStock: boolean;
      variants: { available: number }[];
    };
    expect(detail.variants[0].available).toBe(5);
    expect(detail.inStock).toBe(true);
    await auth.api('anon').get('/products?pageSize=5').expect(200);
  });

  it('fails open: the rate limiter lets every request through when Redis is down', async () => {
    for (let i = 0; i < 125; i++)
      expect((await request(app.getHttpServer()).get('/api/v1/categories')).status).toBe(200); // the limit is 120
  });

  it('still takes orders with Redis down', async () => {
    const user = await shop.customer();
    const variant = await shop.variant(3);
    const order = await shop.order(user, variant, 1);
    placed.push(order.id);
    expect(order.status).toBe('PENDING_PAYMENT');
  });

  it('survives a Stripe outage: 502, no payment row, the reservation hold is untouched, and a retry works', async () => {
    const user = await shop.customer();
    const variant = await shop.variant(3);
    const order = await shop.order(user, variant, 1);
    placed.push(order.id);
    const before = await prisma.stockReservation.findFirstOrThrow({
      where: { orderId: order.id },
      select: { expiresAt: true },
    });

    fake.failCreate = new Stripe.errors.StripeAPIError({
      type: 'api_error',
      message: 'Stripe is down',
    } as never);
    try {
      await auth.api(user).post(`/orders/${order.id}/pay`).expect(502);
    } finally {
      fake.failCreate = null;
    }
    expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(0);
    const after = await prisma.stockReservation.findFirstOrThrow({
      where: { orderId: order.id },
      select: { expiresAt: true },
    });
    expect(after.expiresAt.getTime()).toBe(before.expiresAt.getTime()); // the extension rolled back with the failure

    await shop.pay(user, order.id); // Stripe is back
    expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(1);
  });

  it('answers 503 on readiness when the database is down', async () => {
    const spy = jest
      .spyOn(prisma, '$queryRaw')
      .mockRejectedValueOnce(new Error('connection refused') as never);
    try {
      const res = await request(app.getHttpServer()).get('/health/ready').expect(503);
      expect(res.body).toMatchObject({ status: 'unavailable', db: 'down' });
    } finally {
      spy.mockRestore();
    }
  });
});
