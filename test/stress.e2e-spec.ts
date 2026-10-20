import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { StripeService } from '../src/payments/stripe.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { ReservationsService } from '../src/reservations/reservations.service';
import { TestAuth } from './helpers/auth';
import { stockViolations } from './helpers/invariants';
import { type OrderBody, type PayBody, Shop } from './helpers/shop';
import {
  FakeStripe,
  completedEvent,
  intentId,
  postWebhook,
  stripeServiceValue,
} from './helpers/stripe-fake';

jest.setTimeout(120_000);

describe('Concurrency stress (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let reservations: ReservationsService;
  let auth: TestAuth;
  let shop: Shop;
  const fake = new FakeStripe();
  const placed: string[] = [];

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

  const stock = (variantId: string) =>
    prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId },
      select: { onHand: true, reserved: true },
    });

  /** 40 customers with one unit in their cart each, then everyone checks out at the same instant. */
  async function race(variant: string, shoppers = 40) {
    const users = await Promise.all(Array.from({ length: shoppers }, () => shop.customer()));
    await Promise.all(users.map((u) => shop.addToCart(u, variant)));
    const results = await Promise.all(
      users.map(async (user) => ({ user, res: await shop.checkout(user) })),
    );
    const winners = results
      .filter((r) => r.res.status === 201)
      .map((r) => ({ user: r.user, order: (r.res.body as { order: OrderBody }).order }));
    const losers = results.filter((r) => r.res.status === 409);
    placed.push(...winners.map((w) => w.order.id));
    return { winners, losers, all: results };
  }

  it('launch day: 40 shoppers race for 10 units, exactly 10 win, every winner pays once, nothing oversells', async () => {
    const variant = await shop.variant(10);
    const { winners, losers, all } = await race(variant);

    expect(all.filter((r) => r.res.status >= 500)).toEqual([]);
    expect(winners).toHaveLength(10);
    expect(losers).toHaveLength(30);
    expect(losers.every((l) => (l.res.body as { available: number }).available === 0)).toBe(true);
    expect(await stock(variant)).toEqual({ onHand: 10, reserved: 10 });
    expect(await stockViolations(prisma, [variant])).toEqual([]);

    // everyone pays, and Stripe delivers every event twice, all at once
    const payments: PayBody[] = await Promise.all(winners.map((w) => shop.pay(w.user, w.order.id)));
    const events = winners.map((w, i) => completedEvent(payments[i], w.order, intentId()));
    const deliveries = await Promise.all([...events, ...events].map((e) => postWebhook(app, e)));

    expect(deliveries.every((d) => d.status === 200)).toBe(true);
    const outcomes = deliveries.map((d) => (d.body as { status: string }).status);
    expect(outcomes.filter((s) => s === 'processed')).toHaveLength(10);
    expect(outcomes.filter((s) => s === 'duplicate')).toHaveLength(10);

    const ids = winners.map((w) => w.order.id);
    expect(await stock(variant)).toEqual({ onHand: 0, reserved: 0 });
    expect(await prisma.order.count({ where: { id: { in: ids }, status: 'PAID' } })).toBe(10);
    expect(
      await prisma.inventoryMovement.count({ where: { variantId: variant, type: 'SALE' } }),
    ).toBe(10);
    expect(
      await prisma.outboxEvent.count({ where: { type: 'order.paid', aggregateId: { in: ids } } }),
    ).toBe(10);
    expect(await stockViolations(prisma, [variant])).toEqual([]);
  });

  it('chaos: paying, cancelling, expiring and duplicate webhooks race on the same stock and the books still balance', async () => {
    const variant = await shop.variant(12);
    const { winners } = await race(variant);
    expect(winners).toHaveLength(12);

    const statuses: number[] = [];
    await Promise.all(
      winners.map(async ({ user, order }, i) => {
        const pay = async () => {
          const res = await auth.api(user).post(`/orders/${order.id}/pay`);
          statuses.push(res.status);
          return res;
        };
        const cancel = async () =>
          statuses.push((await auth.api(user).post(`/orders/${order.id}/cancel`)).status);
        const deliver = (p: PayBody) => {
          const event = completedEvent(p, order, intentId());
          return [postWebhook(app, event), postWebhook(app, event)].map(async (r) =>
            statuses.push((await r).status),
          );
        };

        switch (i % 4) {
          case 0: {
            const res = await pay();
            if (res.status === 200) await Promise.all(deliver(res.body as PayBody));
            break;
          }
          case 1:
            await cancel();
            break;
          case 2:
            await prisma.$executeRaw`UPDATE stock_reservations SET expires_at = now() - interval '1 minute' WHERE order_id = ${order.id}::uuid`;
            statuses.push((await auth.api().post('/reservations/expire-due')).status);
            break;
          default: {
            const res = await pay();
            if (res.status === 200) await Promise.all([cancel(), ...deliver(res.body as PayBody)]);
          }
        }
      }),
    );

    expect(statuses.filter((s) => s >= 500)).toEqual([]); // a deadlock or an unhandled race would show up here

    const ids = winners.map((w) => w.order.id);
    const orders = await prisma.order.findMany({
      where: { id: { in: ids } },
      select: { status: true },
    });
    const paid = orders.filter((o) => o.status === 'PAID').length;
    const pending = orders.filter((o) => o.status === 'PENDING_PAYMENT').length;

    expect(await stock(variant)).toEqual({ onHand: 12 - paid, reserved: pending });
    expect(await stockViolations(prisma, [variant])).toEqual([]);
    expect(
      await prisma.inventoryMovement.count({ where: { variantId: variant, type: 'SALE' } }),
    ).toBe(paid);
    expect(
      await prisma.stockReservation.count({
        where: {
          variantId: variant,
          status: 'ACTIVE',
          order: { status: { not: 'PENDING_PAYMENT' } },
        },
      }),
    ).toBe(0);
  });
});
