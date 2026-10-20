import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import type { Env } from '../src/config/env';
import { RabbitMqService } from '../src/messaging/rabbitmq.service';
import { StripeService } from '../src/payments/stripe.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { ReservationsService } from '../src/reservations/reservations.service';
import { WorkerModule } from '../src/worker.module';
import { TestAuth } from './helpers/auth';
import { Shop } from './helpers/shop';
import {
  FakeStripe,
  completedEvent,
  intentId,
  postWebhook,
  stripeServiceValue,
} from './helpers/stripe-fake';

jest.setTimeout(90_000);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check: () => Promise<boolean>, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the condition');
    await sleep(200);
  }
}

// These tests need the infrastructure to themselves: no other worker draining the outbox, and a database
// trigger that makes writes fail. They run only in `pnpm test:int` (serial, on throwaway containers).
describe('Outages and mid-transaction failures (int)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let reservations: ReservationsService;
  let shop: Shop;
  const fake = new FakeStripe();
  const placed: string[] = [];

  const clearTriggers = () =>
    prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS int_test_fail_outbox ON outbox_events');
  const failOutboxInsert = async (type: string) => {
    await prisma.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION int_test_fail_outbox() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END; $$ LANGUAGE plpgsql`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER int_test_fail_outbox BEFORE INSERT ON outbox_events FOR EACH ROW WHEN (NEW.type = '${type}') EXECUTE FUNCTION int_test_fail_outbox()`,
    );
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(StripeService)
      .useValue(stripeServiceValue(fake))
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    reservations = app.get(ReservationsService);
    shop = await Shop.create(await TestAuth.create(app));
    await clearTriggers();
  });

  afterAll(async () => {
    await clearTriggers();
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

  const stock = (variantId: string) =>
    prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId },
      select: { onHand: true, reserved: true },
    });

  it('RabbitMQ outage: orders keep working, events wait in the outbox, and a healthy worker later delivers them', async () => {
    // a worker whose broker is unreachable
    const deadBroker = new RabbitMqService({
      get: () => 'amqp://127.0.0.1:1',
    } as unknown as ConfigService<Env, true>);
    const deadWorker = await Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(RabbitMqService)
      .useValue(deadBroker)
      .compile();
    await deadWorker.init();

    try {
      const user = await shop.customer();
      const order = await shop.order(user, await shop.variant(3), 1); // the API does not care that the broker is down
      placed.push(order.id);
      const row = await prisma.outboxEvent.findFirstOrThrow({
        where: { type: 'order.created', aggregateId: order.id },
      });

      await sleep(3_000); // several publisher ticks
      expect(await prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
        status: 'PENDING',
        attempts: 0,
      });
      await deadWorker.close();

      const healthy = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
      await healthy.init();
      try {
        await healthy.get(RabbitMqService).waitUntilReady(30_000);
        await waitFor(
          async () =>
            (await prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } })).status ===
            'PUBLISHED',
        );
      } finally {
        await healthy.close();
      }
    } finally {
      await deadWorker.close().catch(() => undefined);
    }
  });

  it('a failure while writing the outbox rolls back the whole checkout, and the same key can be retried', async () => {
    const user = await shop.customer();
    const variant = await shop.variant(5);
    await shop.addToCart(user, variant, 2);
    const key = `int-key-${Date.now()}`;

    await failOutboxInsert('order.created');
    try {
      const res = await shop.checkout(user, key);
      expect(res.status).toBe(500);
    } finally {
      await clearTriggers();
    }

    expect(await prisma.order.count({ where: { userId: user } })).toBe(0);
    expect(await prisma.stockReservation.count({ where: { variantId: variant } })).toBe(0);
    expect(
      await prisma.inventoryMovement.count({ where: { variantId: variant, type: 'RESERVE' } }),
    ).toBe(0);
    expect(await stock(variant)).toEqual({ onHand: 5, reserved: 0 });

    const retry = await shop.checkout(user, key).expect(201); // nothing was persisted, so the key is still free
    placed.push((retry.body as { order: { id: string } }).order.id);
    expect(await stock(variant)).toEqual({ onHand: 5, reserved: 2 });
  });

  it("a webhook that fails mid-transaction leaves no trace, and Stripe's retry of the same event succeeds", async () => {
    const user = await shop.customer();
    const variant = await shop.variant(5);
    const order = await shop.order(user, variant, 2);
    placed.push(order.id);
    const p = await shop.pay(user, order.id);
    const event = completedEvent(p, order, intentId());

    await failOutboxInsert('order.paid');
    try {
      expect((await postWebhook(app, event)).status).toBe(500); // Stripe would retry
    } finally {
      await clearTriggers();
    }

    expect(await prisma.stripeWebhookEvent.count({ where: { stripeEventId: event.id } })).toBe(0); // the event row rolled back too
    expect(await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } })).toMatchObject({
      status: 'PENDING',
    });
    expect(
      (await prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true } }))
        .status,
    ).toBe('PENDING_PAYMENT');
    expect(await stock(variant)).toEqual({ onHand: 5, reserved: 2 });
    expect(
      await prisma.inventoryMovement.count({ where: { variantId: variant, type: 'SALE' } }),
    ).toBe(0);

    const retry = await postWebhook(app, event); // Stripe's retry of the very same event
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ status: 'processed' });
    expect(
      (await prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true } }))
        .status,
    ).toBe('PAID');
    expect(await stock(variant)).toEqual({ onHand: 3, reserved: 0 });
    expect(
      await prisma.inventoryMovement.count({ where: { variantId: variant, type: 'SALE' } }),
    ).toBe(1);
  });
});
