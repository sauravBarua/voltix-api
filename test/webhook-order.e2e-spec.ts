import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { StripeService } from '../src/payments/stripe.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { ReservationsService } from '../src/reservations/reservations.service';
import { TestAuth } from './helpers/auth';
import { stockViolations } from './helpers/invariants';
import { Shop } from './helpers/shop';
import {
  FakeStripe,
  completedEvent,
  expiredEvent,
  failedEvent,
  intentId,
  newEvent,
  postWebhook,
  refundedEvent,
  signPayload,
  stripeServiceValue,
} from './helpers/stripe-fake';

jest.setTimeout(60_000);

type Kind = 'failed' | 'completed' | 'refunded';

const permutations = <T>(items: T[]): T[][] =>
  items.length <= 1
    ? [items]
    : items.flatMap((x, i) =>
        permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [x, ...rest]),
      );
const ORDERINGS = permutations<Kind>(['failed', 'completed', 'refunded']).map(
  (p): [string, Kind[]] => [p.join(' -> '), p],
);

describe('Stripe webhook ordering, duplicates and tampering (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let reservations: ReservationsService;
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
    shop = await Shop.create(await TestAuth.create(app));
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
  const orderRow = (id: string) =>
    prisma.order.findUniqueOrThrow({ where: { id }, select: { status: true } });
  const paymentRow = (orderId: string) => prisma.payment.findFirstOrThrow({ where: { orderId } });

  /** A pending order of 2 units (stock 5), with its Checkout Session created. */
  async function payable() {
    const user = await shop.customer();
    const variant = await shop.variant(5);
    const order = await shop.order(user, variant, 2);
    placed.push(order.id);
    return { user, variant, order, p: await shop.pay(user, order.id), intent: intentId() };
  }

  it.each(ORDERINGS)(
    'ends refunded and booked exactly once however Stripe orders the events: %s',
    async (_label, sequence) => {
      const { variant, order, p, intent } = await payable();
      const events = {
        failed: failedEvent(p, order.id, intent),
        completed: completedEvent(p, order, intent),
        refunded: refundedEvent(intent, order.totalMinor),
      };

      const deferred: Kind[] = [];
      for (const kind of sequence) {
        const res = await postWebhook(app, events[kind]);
        if (res.status === 409) {
          expect(kind).toBe('refunded'); // only a refund may be asked to retry later
          deferred.push(kind);
          continue;
        }
        expect(res.status).toBe(200);
        const again = await postWebhook(app, events[kind]); // Stripe delivers at least once
        expect((again.body as { status: string }).status).toBe('duplicate');
      }
      for (const kind of deferred) expect((await postWebhook(app, events[kind])).status).toBe(200); // Stripe's retry

      expect((await orderRow(order.id)).status).toBe('REFUNDED');
      expect(await paymentRow(order.id)).toMatchObject({
        status: 'REFUNDED',
        refundedMinor: order.totalMinor,
        stripePaymentIntentId: intent,
      });
      expect(await stock(variant)).toEqual({ onHand: 3, reserved: 0 }); // sold once, no restock was requested
      expect(
        await prisma.inventoryMovement.count({ where: { variantId: variant, type: 'SALE' } }),
      ).toBe(1);
      expect(await stockViolations(prisma, [variant])).toEqual([]);
    },
  );

  it.each([
    ['failed -> expired', ['failed', 'expired']],
    ['expired -> failed', ['expired', 'failed']],
  ] as [string, ('failed' | 'expired')[]][])(
    'releases the stock and never marks the order paid: %s',
    async (_label, sequence) => {
      const { variant, order, p, intent } = await payable();
      const events = { failed: failedEvent(p, order.id, intent), expired: expiredEvent(p) };
      for (const kind of sequence) expect((await postWebhook(app, events[kind])).status).toBe(200);

      expect(['PAYMENT_FAILED', 'CANCELLED']).toContain((await orderRow(order.id)).status);
      expect(['FAILED', 'EXPIRED']).toContain((await paymentRow(order.id)).status);
      expect(await stock(variant)).toEqual({ onHand: 5, reserved: 0 });
      expect(await stockViolations(prisma, [variant])).toEqual([]);
    },
  );

  it('does not sell twice when Stripe sends a second completed event with a different id', async () => {
    const { variant, order, p, intent } = await payable();
    expect((await postWebhook(app, completedEvent(p, order, intent))).status).toBe(200);
    expect((await postWebhook(app, completedEvent(p, order, intent))).status).toBe(200);

    expect(await stock(variant)).toEqual({ onHand: 3, reserved: 0 });
    expect(
      await prisma.inventoryMovement.count({ where: { variantId: variant, type: 'SALE' } }),
    ).toBe(1);
    expect(
      await prisma.outboxEvent.count({ where: { type: 'order.paid', aggregateId: order.id } }),
    ).toBe(1);
  });

  it('ignores an unpaid completion or a wrong amount, and still accepts the real payment afterwards', async () => {
    const { variant, order, p, intent } = await payable();

    expect(
      (await postWebhook(app, completedEvent(p, order, intent, { payment_status: 'unpaid' })))
        .status,
    ).toBe(200);
    expect(
      (
        await postWebhook(
          app,
          completedEvent(p, order, intent, { amount_total: order.totalMinor - 1 }),
        )
      ).status,
    ).toBe(200);
    expect((await orderRow(order.id)).status).toBe('PENDING_PAYMENT');
    expect(await paymentRow(order.id)).toMatchObject({ status: 'PENDING' });
    expect(await stock(variant)).toEqual({ onHand: 5, reserved: 2 });

    expect((await postWebhook(app, completedEvent(p, order, intent))).status).toBe(200);
    expect((await orderRow(order.id)).status).toBe('PAID');
    expect(await stock(variant)).toEqual({ onHand: 3, reserved: 0 });
  });

  it('rejects tampered, stale, foreign-secret and unsigned events and records none of them', async () => {
    const event = newEvent('customer.created', { id: 'cus_x' });
    const payload = JSON.stringify(event);
    const send = (body: string, signature?: string) => {
      const req = request(app.getHttpServer())
        .post('/webhooks/stripe')
        .set('Content-Type', 'application/json');
      if (signature) req.set('Stripe-Signature', signature);
      return req.send(body);
    };

    await send(JSON.stringify({ ...event, id: 'evt_tampered' }), signPayload(payload)).expect(400); // body changed after signing
    await send(
      payload,
      signPayload(payload, { timestamp: Math.floor(Date.now() / 1000) - 3600 }),
    ).expect(400); // replay of an old delivery
    await send(payload, signPayload(payload, { secret: 'whsec_somebody_else' })).expect(400);
    await send(payload).expect(400);

    expect(
      await prisma.stripeWebhookEvent.count({
        where: { stripeEventId: { in: [event.id, 'evt_tampered'] } },
      }),
    ).toBe(0);
    await send(payload, signPayload(payload)).expect(200); // and the genuine one still works
  });
});
