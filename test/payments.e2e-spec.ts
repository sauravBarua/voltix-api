import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import Stripe from 'stripe';
import { AppModule } from '../src/app.module';
import { API_PREFIX, configureApp } from '../src/app.setup';
import { StripeService } from '../src/payments/stripe.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { ReservationsService } from '../src/reservations/reservations.service';

const WEBHOOK_SECRET = 'whsec_e2e_test_secret';
// Only used for webhook signing helpers: makes no API call
const realStripe = new Stripe('sk_test_e2e_dummy');
const chargeOf = (intent: string) => `ch_${intent}`;

type FakeSession = {
  id: string;
  status: 'open' | 'complete' | 'expired';
  url: string;
  expires_at: number;
  amount_total: number;
  metadata: Record<string, string | number | null>;
};
type RefundRecord = {
  id: string;
  payment_intent: string;
  amount: number;
  status: 'succeeded';
  metadata: Record<string, string>;
};

class FakeStripe {
  sessions = new Map<string, FakeSession>();
  createCalls: { params: Stripe.Checkout.SessionCreateParams; idempotencyKey?: string }[] = [];
  expireCalls: string[] = [];
  refundCalls: { params: Stripe.RefundCreateParams; idempotencyKey?: string }[] = [];
  refundRecords: RefundRecord[] = [];
  private byKey = new Map<string, FakeSession>();
  webhooks = realStripe.webhooks;

  checkout = {
    sessions: {
      create: (params: Stripe.Checkout.SessionCreateParams, opts?: { idempotencyKey?: string }) => {
        this.createCalls.push({ params, idempotencyKey: opts?.idempotencyKey });
        const key = opts?.idempotencyKey;
        const known = key ? this.byKey.get(key) : undefined;
        if (known) return Promise.resolve(known);
        const id = `cs_test_${randomUUID().replaceAll('-', '')}`;
        const session: FakeSession = {
          id,
          status: 'open',
          url: `https://checkout.stripe.test/${id}`,
          expires_at: params.expires_at ?? 0,
          amount_total: (params.line_items ?? []).reduce(
            (sum, l) => sum + (l.price_data?.unit_amount ?? 0) * (l.quantity ?? 1),
            0,
          ),
          metadata: { ...params.metadata },
        };
        this.sessions.set(id, session);
        if (key) this.byKey.set(key, session);
        return Promise.resolve(session);
      },
      retrieve: (id: string) => {
        const session = this.sessions.get(id);
        return session
          ? Promise.resolve(session)
          : Promise.reject(new Error(`No such session ${id}`));
      },
      expire: (id: string) => {
        this.expireCalls.push(id);
        const session = this.sessions.get(id);
        if (!session) return Promise.reject(new Error(`No such session ${id}`));
        if (session.status !== 'open') {
          return Promise.reject(
            new Stripe.errors.StripeInvalidRequestError({
              type: 'invalid_request_error',
              message: 'Only open Checkout Sessions can be expired',
            } as never),
          );
        }
        session.status = 'expired';
        return Promise.resolve(session);
      },
    },
  };

  refunds = {
    create: (params: Stripe.RefundCreateParams, opts?: { idempotencyKey?: string }) => {
      this.refundCalls.push({ params, idempotencyKey: opts?.idempotencyKey });
      const record: RefundRecord = {
        id: `re_${randomUUID().replaceAll('-', '')}`,
        payment_intent: String(params.payment_intent),
        amount: params.amount ?? 0,
        status: 'succeeded',
        metadata: { ...(params.metadata as Record<string, string>) },
      };
      this.refundRecords.push(record);
      return Promise.resolve(record);
    },
    list: (params: { charge: string }) =>
      Promise.resolve({
        data: this.refundRecords.filter((r) => chargeOf(r.payment_intent) === params.charge),
      }),
  };
}

type Ref = { id: string; slug: string };
type OrderBody = { id: string; orderNumber: string; status: string; totalMinor: number };
type PayBody = { paymentId: string; sessionId: string; url: string; expiresAt: string };

const address = {
  fullName: 'Test Customer',
  line1: '1 Rue de Test',
  city: 'Paris',
  postalCode: '75001',
  country: 'FR',
};

describe('Payments (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let reservations: ReservationsService;
  let brandId: string;
  let categoryId: string;
  let counter = 0;
  const fake = new FakeStripe();
  const placed: string[] = [];
  const suffix = Date.now().toString(36).toUpperCase();
  const specs = { cpu: 'Test CPU', screenSizeInch: 15.6, os: 'Windows 11' };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(StripeService)
      .useValue({
        client: fake as unknown as Stripe,
        webhookSecret: WEBHOOK_SECRET,
        frontendUrl: 'http://localhost:3001',
      })
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    reservations = app.get(ReservationsService);

    const brands = (await api().get('/brands').expect(200)).body as Ref[];
    const categories = (await api().get('/categories').expect(200)).body as Ref[];
    brandId = brands.find((b) => b.slug === 'dell')!.id;
    categoryId = categories.find((c) => c.slug === 'laptops')!.id;
  });

  afterAll(async () => {
    // Free whatever is still open so the dev database stays clean
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

  const api = (userId?: string) => {
    const server = app.getHttpServer();
    const url = (p: string) => `/${API_PREFIX}${p}`;
    const as = (t: request.Test) => (userId ? t.set('x-user-id', userId) : t);
    return {
      get: (p: string) => as(request(server).get(url(p))),
      post: (p: string) => as(request(server).post(url(p))),
      patch: (p: string) => as(request(server).patch(url(p))),
      delete: (p: string) => as(request(server).delete(url(p))),
    };
  };

  // ── signed webhook helpers (real SDK signing, fake API) ──
  const post = (event: object, signature?: string | null) => {
    const payload = JSON.stringify(event);
    const req = request(app.getHttpServer())
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json');
    if (signature !== null) {
      req.set(
        'Stripe-Signature',
        signature ??
          realStripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET }),
      );
    }
    return req.send(payload);
  };
  const newEvent = (type: string, object: Record<string, unknown>) => ({
    id: `evt_${randomUUID().replaceAll('-', '')}`,
    object: 'event',
    api_version: '2025-01-01',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type,
    data: { object },
  });
  const intentId = () => `pi_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const completed = (p: PayBody, order: OrderBody, intent: string) =>
    newEvent('checkout.session.completed', {
      id: p.sessionId,
      object: 'checkout.session',
      payment_status: 'paid',
      payment_intent: intent,
      amount_total: order.totalMinor,
      currency: 'eur',
      metadata: { orderId: order.id, paymentId: p.paymentId },
    });
  const expired = (p: PayBody) =>
    newEvent('checkout.session.expired', {
      id: p.sessionId,
      object: 'checkout.session',
      status: 'expired',
      metadata: {},
    });
  const refunded = (intent: string, amount: number) =>
    newEvent('charge.refunded', {
      id: chargeOf(intent),
      object: 'charge',
      payment_intent: intent,
      amount_refunded: amount,
    });

  // ── data helpers ──
  const createUser = async () =>
    (
      await prisma.user.create({
        data: { email: `payments-${suffix}-${++counter}@voltix.test`, name: 'Payments Test' },
        select: { id: true },
      })
    ).id;

  const createVariant = async (stock: number) => {
    const n = ++counter;
    const product = (
      await api()
        .post('/products')
        .field(
          'data',
          JSON.stringify({ name: `Payment Laptop ${suffix}-${n}`, brandId, categoryId, specs }),
        )
        .expect(201)
    ).body as { id: string };
    const variant = (
      await api()
        .post(`/products/${product.id}/variants`)
        .field(
          'data',
          JSON.stringify({ sku: `PAY-${suffix}-${n}`, name: 'Payment variant', priceMinor: 1000 }),
        )
        .expect(201)
    ).body as { id: string };
    if (stock > 0)
      await api()
        .post(`/inventory/variants/${variant.id}/stock-in`)
        .send({ quantity: stock })
        .expect(201);
    return variant.id;
  };

  const checkoutFor = async (user: string, variant: string, quantity: number) => {
    await api(user).post('/cart/items').send({ variantId: variant, quantity }).expect(200);
    const res = await api(user)
      .post('/orders/checkout')
      .set('Idempotency-Key', randomUUID())
      .send({ shippingAddress: address })
      .expect(201);
    const order = (res.body as { order: OrderBody }).order;
    placed.push(order.id);
    return order;
  };

  /** A fresh user with an unpaid order (flat shipping: total = quantity x 1000 + 990). */
  const placeOrder = async (opts: { stock?: number; qty?: number; variant?: string } = {}) => {
    const user = await createUser();
    const variant = opts.variant ?? (await createVariant(opts.stock ?? 5));
    const order = await checkoutFor(user, variant, opts.qty ?? 2);
    return { user, variant, order };
  };

  const pay = async (user: string, order: OrderBody) =>
    (await api(user).post(`/orders/${order.id}/pay`).expect(200)).body as PayBody;

  /** An order that is paid through the webhook, with its intent. */
  const paidOrder = async (opts: { stock?: number; qty?: number } = {}) => {
    const placedOrder = await placeOrder(opts);
    const p = await pay(placedOrder.user, placedOrder.order);
    const intent = intentId();
    await post(completed(p, placedOrder.order, intent)).expect(200);
    return { ...placedOrder, p, intent };
  };

  const stockRow = (variantId: string) =>
    prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId },
      select: { onHand: true, reserved: true },
    });
  const orderRow = (id: string) =>
    prisma.order.findUniqueOrThrow({
      where: { id },
      select: { status: true, cancelReason: true, paidAt: true },
    });
  const paymentRow = (orderId: string) => prisma.payment.findFirstOrThrow({ where: { orderId } });
  const forceExpiry = (orderId: string) =>
    prisma.$executeRaw`UPDATE stock_reservations SET expires_at = now() - interval '1 minute' WHERE order_id = ${orderId}::uuid`;
  const refundCallsOf = (orderId: string) =>
    fake.refundCalls.filter(
      (c) => (c.params.metadata as Record<string, string> | undefined)?.orderId === orderId,
    );

  // ─────────────── pay ───────────────

  it('creates a Checkout Session from server-side amounts and extends the reservation hold', async () => {
    const { user, order } = await placeOrder({ qty: 2 });
    await api().post(`/orders/${order.id}/pay`).expect(401);

    const body = await pay(user, order);
    expect(body.url).toContain('https://checkout.stripe.test/');

    const call = fake.createCalls.find((c) => c.params.metadata?.orderId === order.id)!;
    expect(call.idempotencyKey).toBe(`checkout-session:${order.id}:1`);
    expect(call.params).toMatchObject({
      mode: 'payment',
      client_reference_id: order.id,
      metadata: { orderId: order.id, paymentId: body.paymentId },
    });
    const lines = call.params.line_items ?? [];
    expect(
      lines.reduce((s, l) => s + (l.price_data?.unit_amount ?? 0) * (l.quantity ?? 1), 0),
    ).toBe(order.totalMinor);
    expect(order.totalMinor).toBe(2990);
    expect(call.params.expires_at).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000) + 30 * 60);

    expect(await paymentRow(order.id)).toMatchObject({
      status: 'PENDING',
      amountMinor: order.totalMinor,
      currency: 'EUR',
      stripeSessionId: body.sessionId,
    });
    const reservation = await prisma.stockReservation.findFirstOrThrow({
      where: { orderId: order.id },
    });
    expect(reservation.expiresAt.getTime()).toBeGreaterThanOrEqual(
      (call.params.expires_at ?? 0) * 1000 + 119_000,
    );

    const again = await pay(user, order); // idempotent: same open session, no new Stripe session
    expect(again.sessionId).toBe(body.sessionId);
    expect(fake.createCalls.filter((c) => c.params.metadata?.orderId === order.id)).toHaveLength(1);
  });

  it('creates one session under parallel /pay calls', async () => {
    const { user, order } = await placeOrder();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => api(user).post(`/orders/${order.id}/pay`)),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => (r.body as PayBody).sessionId)).size).toBe(1);
    expect(fake.createCalls.filter((c) => c.params.metadata?.orderId === order.id)).toHaveLength(1);
    expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(1);
  });

  it('refuses orders of other users (404) and orders not awaiting payment (409)', async () => {
    const { user, order } = await placeOrder();
    const stranger = await createUser();
    await api(stranger).post(`/orders/${order.id}/pay`).expect(404);

    await api(user).post(`/orders/${order.id}/cancel`).expect(201);
    await api(user).post(`/orders/${order.id}/pay`).expect(409);
  });

  // ─────────────── webhook security and idempotency ───────────────

  it('rejects missing and invalid signatures with 400, and records nothing', async () => {
    const event = newEvent('checkout.session.expired', { id: 'cs_test_x' });
    await post(event, null).expect(400);
    await post(event, 't=1,v1=deadbeef').expect(400);
    expect(await prisma.stripeWebhookEvent.count({ where: { stripeEventId: event.id } })).toBe(0);
  });

  it('ignores unknown sessions and events without our metadata (200)', async () => {
    const unknown = completed(
      { paymentId: randomUUID(), sessionId: 'cs_test_unknown', url: '', expiresAt: '' },
      { id: randomUUID(), orderNumber: '', status: '', totalMinor: 1 },
      intentId(),
    );
    expect((await post(unknown).expect(200)).body).toMatchObject({
      received: true,
      status: 'processed',
    });
    await post(newEvent('payment_intent.payment_failed', { id: intentId(), metadata: {} })).expect(
      200,
    );
    await post(newEvent('customer.created', { id: 'cus_x' })).expect(200);
  });

  // ─────────────── payment success ───────────────

  it('marks the order paid: sale recorded, stock decreased, cart cleared, outbox written', async () => {
    const { user, variant, order } = await placeOrder({ stock: 5, qty: 2 });
    const p = await pay(user, order);
    const intent = intentId();
    const event = completed(p, order, intent);

    const res = await post(event).expect(200);
    expect(res.body).toMatchObject({ received: true, status: 'processed' });

    expect(await orderRow(order.id)).toMatchObject({ status: 'PAID' });
    expect((await orderRow(order.id)).paidAt).not.toBeNull();
    expect(await paymentRow(order.id)).toMatchObject({
      status: 'PAID',
      stripePaymentIntentId: intent,
    });
    expect(await stockRow(variant)).toEqual({ onHand: 3, reserved: 0 });
    expect(
      await prisma.stockReservation.findFirstOrThrow({ where: { orderId: order.id } }),
    ).toMatchObject({ status: 'CONSUMED' });
    expect(
      await prisma.inventoryMovement.count({ where: { variantId: variant, type: 'SALE' } }),
    ).toBe(1);
    expect(
      await prisma.outboxEvent.count({ where: { aggregateId: order.id, type: 'order.paid' } }),
    ).toBe(1);
    expect(
      ((await api(user).get('/cart').expect(200)).body as { itemCount: number }).itemCount,
    ).toBe(0);

    // the same event again is a no-op
    expect((await post(event).expect(200)).body).toMatchObject({ status: 'duplicate' });
    expect(await stockRow(variant)).toEqual({ onHand: 3, reserved: 0 });
    expect(
      await prisma.outboxEvent.count({ where: { aggregateId: order.id, type: 'order.paid' } }),
    ).toBe(1);
  });

  it('applies a payment once under parallel duplicate deliveries', async () => {
    const { user, variant, order } = await placeOrder({ stock: 5, qty: 2 });
    const event = completed(await pay(user, order), order, intentId());

    const results = await Promise.all(Array.from({ length: 5 }, () => post(event)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const statuses = results.map((r) => (r.body as { status: string }).status);
    expect(statuses.filter((s) => s === 'processed')).toHaveLength(1);
    expect(statuses.filter((s) => s === 'duplicate')).toHaveLength(4);
    expect(await stockRow(variant)).toEqual({ onHand: 3, reserved: 0 });
    expect(
      await prisma.inventoryMovement.count({ where: { variantId: variant, type: 'SALE' } }),
    ).toBe(1);
  });

  // ─────────────── failure and expiry ───────────────

  it('keeps the order open after a declined card, then fails it when the session expires', async () => {
    const { user, variant, order } = await placeOrder({ stock: 5, qty: 2 });
    const p = await pay(user, order);

    await post(
      newEvent('payment_intent.payment_failed', {
        id: intentId(),
        metadata: { orderId: order.id, paymentId: p.paymentId },
        last_payment_error: { message: 'Your card was declined.' },
      }),
    ).expect(200);
    expect(await paymentRow(order.id)).toMatchObject({
      status: 'PENDING',
      failureReason: 'Your card was declined.',
    });
    expect((await orderRow(order.id)).status).toBe('PENDING_PAYMENT');
    expect(await stockRow(variant)).toEqual({ onHand: 5, reserved: 2 }); // the customer can retry

    await post(expired(p)).expect(200);
    expect(await orderRow(order.id)).toMatchObject({
      status: 'PAYMENT_FAILED',
      cancelReason: 'PAYMENT_FAILED',
    });
    expect(await paymentRow(order.id)).toMatchObject({ status: 'FAILED' });
    expect(await stockRow(variant)).toEqual({ onHand: 5, reserved: 0 });
  });

  it('cancels and releases the stock when the session expires unpaid', async () => {
    const { user, variant, order } = await placeOrder({ stock: 5, qty: 2 });
    const p = await pay(user, order);

    await post(expired(p)).expect(200);
    expect(await orderRow(order.id)).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'PAYMENT_EXPIRED',
    });
    expect(await paymentRow(order.id)).toMatchObject({ status: 'EXPIRED' });
    expect(
      await prisma.stockReservation.findFirstOrThrow({ where: { orderId: order.id } }),
    ).toMatchObject({ status: 'EXPIRED' });
    expect(await stockRow(variant)).toEqual({ onHand: 5, reserved: 0 });
    expect(
      await prisma.outboxEvent.count({ where: { aggregateId: order.id, type: 'order.cancelled' } }),
    ).toBe(1);

    await api(user)
      .post('/orders/checkout')
      .set('Idempotency-Key', randomUUID())
      .send({ shippingAddress: address })
      .expect(201);
  });

  it('closes the Checkout Session when the customer cancels, and refuses once it is complete', async () => {
    const first = await placeOrder();
    const p1 = await pay(first.user, first.order);
    await api(first.user).post(`/orders/${first.order.id}/cancel`).expect(201);
    expect(fake.expireCalls).toContain(p1.sessionId);
    expect((await orderRow(first.order.id)).status).toBe('CANCELLED');
    await post(expired(p1)).expect(200); // the webhook that follows only closes the payment
    expect(await paymentRow(first.order.id)).toMatchObject({ status: 'EXPIRED' });

    const second = await placeOrder();
    const p2 = await pay(second.user, second.order);
    fake.sessions.get(p2.sessionId)!.status = 'complete'; // the customer just paid
    await api(second.user).post(`/orders/${second.order.id}/cancel`).expect(409);
    expect((await orderRow(second.order.id)).status).toBe('PENDING_PAYMENT');
  });

  // ─────────────── payment after the reservation was released ───────────────

  it('expires the Checkout Session with the reservation, and recovers a late payment when stock is free', async () => {
    const { user, variant, order } = await placeOrder({ stock: 5, qty: 2 });
    const p = await pay(user, order);

    await forceExpiry(order.id);
    await api().post('/reservations/expire-due').expect(200);
    expect(fake.expireCalls).toContain(p.sessionId);
    expect((await orderRow(order.id)).status).toBe('CANCELLED');
    expect(await stockRow(variant)).toEqual({ onHand: 5, reserved: 0 });

    await post(completed(p, order, intentId())).expect(200); // the payment raced the expiry
    expect(await orderRow(order.id)).toMatchObject({ status: 'PAID', cancelReason: null });
    expect(await stockRow(variant)).toEqual({ onHand: 3, reserved: 0 });
    expect(
      await prisma.inventoryMovement.count({ where: { variantId: variant, type: 'SALE' } }),
    ).toBe(1);
    expect(refundCallsOf(order.id)).toHaveLength(0);
  });

  it('auto-refunds a late payment when the stock was taken meanwhile, without touching the other order', async () => {
    const a = await placeOrder({ stock: 2, qty: 2 });
    const pA = await pay(a.user, a.order);
    await forceExpiry(a.order.id);
    await api().post('/reservations/expire-due').expect(200);

    const userB = await createUser();
    const orderB = await checkoutFor(userB, a.variant, 2); // takes the released units
    expect(await stockRow(a.variant)).toEqual({ onHand: 2, reserved: 2 });

    const intent = intentId();
    await post(completed(pA, a.order, intent)).expect(200);

    expect(await orderRow(a.order.id)).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'PAID_AFTER_EXPIRY',
    });
    const payment = await paymentRow(a.order.id);
    expect(payment).toMatchObject({ status: 'PAID', failureReason: 'PAID_AFTER_EXPIRY_NO_STOCK' });
    const refunds = refundCallsOf(a.order.id);
    expect(refunds).toHaveLength(1);
    expect(refunds[0].params).toMatchObject({ payment_intent: intent, amount: a.order.totalMinor });
    expect(refunds[0].idempotencyKey).toBe(`auto-refund:${payment.id}`);
    expect(await stockRow(a.variant)).toEqual({ onHand: 2, reserved: 2 }); // B is untouched
    expect((await orderRow(orderB.id)).status).toBe('PENDING_PAYMENT');

    await post(refunded(intent, a.order.totalMinor)).expect(200);
    expect(await paymentRow(a.order.id)).toMatchObject({
      status: 'REFUNDED',
      refundedMinor: a.order.totalMinor,
    });
    expect((await orderRow(a.order.id)).status).toBe('CANCELLED'); // a refunded cancellation stays cancelled
  });

  // ─────────────── out-of-order delivery ───────────────

  it('answers 409 for a refund that arrives before the payment is recorded, and processes it on retry', async () => {
    const { user, order } = await placeOrder({ qty: 2 });
    const p = await pay(user, order);
    const intent = intentId();

    const early = refunded(intent, order.totalMinor);
    await post(early).expect(409);
    expect(await prisma.stripeWebhookEvent.count({ where: { stripeEventId: early.id } })).toBe(0); // retryable

    await post(completed(p, order, intent)).expect(200);
    expect((await post(early).expect(200)).body).toMatchObject({ status: 'processed' });
    expect(await orderRow(order.id)).toMatchObject({ status: 'REFUNDED' });
  });

  // ─────────────── refunds ───────────────

  it('validates the admin refund request', async () => {
    const { order } = await paidOrder();
    const url = `/admin/orders/${order.id}/refund`;
    const body = { restock: false, reason: 'Customer request' };

    await api().post(url).send(body).expect(400); // Idempotency-Key required
    await api()
      .post(url)
      .set('Idempotency-Key', 'refund-key-0001')
      .send({ reason: 'No restock field' })
      .expect(400);
    await api()
      .post(url)
      .set('Idempotency-Key', 'refund-key-0001')
      .send({ restock: false, reason: 'x' })
      .expect(400);
    await api()
      .post(`/admin/orders/${randomUUID()}/refund`)
      .set('Idempotency-Key', 'refund-key-0001')
      .send(body)
      .expect(404);

    const unpaid = await placeOrder();
    await api()
      .post(`/admin/orders/${unpaid.order.id}/refund`)
      .set('Idempotency-Key', 'refund-key-0001')
      .send(body)
      .expect(409);
  });

  it('refunds in full with restock: Stripe is asked once, the webhook finalizes order, payment and stock', async () => {
    const { variant, order, intent } = await paidOrder({ stock: 5, qty: 2 });
    expect(await stockRow(variant)).toEqual({ onHand: 3, reserved: 0 });

    const res = await api()
      .post(`/admin/orders/${order.id}/refund`)
      .set('Idempotency-Key', 'refund-key-full-1')
      .send({ restock: true, reason: 'Returned unopened' })
      .expect(202);
    const body = res.body as { stripeRefundId: string; amountMinor: number; full: boolean };
    expect(body).toMatchObject({ amountMinor: order.totalMinor, full: true, restock: true });

    const call = refundCallsOf(order.id)[0];
    expect(call.params).toMatchObject({ payment_intent: intent, amount: order.totalMinor });
    expect(call.params.metadata).toMatchObject({ restock: 'true', orderId: order.id });
    expect(call.idempotencyKey).toBe(`refund:${order.id}:refund-key-full-1`);
    expect(await stockRow(variant)).toEqual({ onHand: 3, reserved: 0 }); // nothing changes before the webhook

    await post(refunded(intent, order.totalMinor)).expect(200);
    expect(await paymentRow(order.id)).toMatchObject({
      status: 'REFUNDED',
      refundedMinor: order.totalMinor,
    });
    expect((await orderRow(order.id)).status).toBe('REFUNDED');
    expect(await stockRow(variant)).toEqual({ onHand: 5, reserved: 0 });
    const returns = await prisma.inventoryMovement.findMany({
      where: { variantId: variant, type: 'RETURN' },
    });
    expect(returns).toHaveLength(1);
    expect(returns[0]).toMatchObject({
      deltaOnHand: 2,
      referenceType: 'REFUND',
      referenceId: body.stripeRefundId,
    });

    // a second delivery for the same refund (new event id) restocks nothing more
    await post(refunded(intent, order.totalMinor)).expect(200);
    expect(await stockRow(variant)).toEqual({ onHand: 5, reserved: 0 });
    expect(
      await prisma.inventoryMovement.count({ where: { variantId: variant, type: 'RETURN' } }),
    ).toBe(1);

    await api()
      .post(`/admin/orders/${order.id}/refund`)
      .set('Idempotency-Key', 'refund-key-full-2')
      .send({ restock: false, reason: 'Again' })
      .expect(409);
  });

  it('supports a partial refund without restock, and refuses restock or over-refunds', async () => {
    const { variant, order, intent } = await paidOrder({ stock: 5, qty: 2 });
    const url = `/admin/orders/${order.id}/refund`;

    await api()
      .post(url)
      .set('Idempotency-Key', 'refund-key-part-1')
      .send({ amountMinor: 500, restock: true, reason: 'Goodwill' })
      .expect(400);
    await api()
      .post(url)
      .set('Idempotency-Key', 'refund-key-part-1')
      .send({ amountMinor: order.totalMinor + 1, restock: false, reason: 'Too much' })
      .expect(400);

    const res = await api()
      .post(url)
      .set('Idempotency-Key', 'refund-key-part-1')
      .send({ amountMinor: 500, restock: false, reason: 'Goodwill' })
      .expect(202);
    expect(res.body).toMatchObject({ amountMinor: 500, full: false });

    await post(refunded(intent, 500)).expect(200);
    expect(await paymentRow(order.id)).toMatchObject({
      status: 'PARTIALLY_REFUNDED',
      refundedMinor: 500,
    });
    expect((await orderRow(order.id)).status).toBe('PARTIALLY_REFUNDED');
    expect(await stockRow(variant)).toEqual({ onHand: 3, reserved: 0 });

    // an older event delivered late cannot lower the refunded total
    await post(refunded(intent, 200)).expect(200);
    expect(await paymentRow(order.id)).toMatchObject({ refundedMinor: 500 });
  });
});
