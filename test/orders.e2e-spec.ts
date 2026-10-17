import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { ReservationsService } from '../src/reservations/reservations.service';
import { TestAuth } from './helpers/auth';

type Ref = { id: string; slug: string };
type OrderBody = {
  id: string;
  orderNumber: string;
  status: string;
  items: {
    variantId: string;
    sku: string;
    name: string;
    unitPriceMinor: number;
    quantity: number;
    lineTotalMinor: number;
  }[];
  subtotalMinor: number;
  shippingMinor: number;
  totalMinor: number;
  currency: string;
  expiresAt: string | null;
  cancelReason: string | null;
  shippedAt: string | null;
  customer?: { email: string };
};
type CheckoutBody = { replayed: boolean; order: OrderBody };
type ListBody = { items: OrderBody[]; meta: { total: number } };

const address = {
  fullName: 'Test Customer',
  line1: '1 Rue de Test',
  city: 'Paris',
  postalCode: '75001',
  country: 'FR',
};

describe('Orders (e2e)', () => {
  let app: INestApplication<App>;
  let auth: TestAuth;
  let prisma: PrismaService;
  let reservations: ReservationsService;
  let brandId: string;
  let categoryId: string;
  let counter = 0;
  const placed: string[] = [];
  const suffix = Date.now().toString(36).toUpperCase();
  const specs = { cpu: 'Test CPU', screenSizeInch: 15.6, os: 'Windows 11' };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    auth = await TestAuth.create(app);
    prisma = app.get(PrismaService);
    reservations = app.get(ReservationsService);

    const brands = (await api().get('/brands').expect(200)).body as Ref[];
    const categories = (await api().get('/categories').expect(200)).body as Ref[];
    brandId = brands.find((b) => b.slug === 'dell')!.id;
    categoryId = categories.find((c) => c.slug === 'laptops')!.id;
  });

  afterAll(async () => {
    // Release every order still open so the dev database stays clean
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

  /** Requests under /api/v1, optionally as a given user (bearer token). */
  const api = (userId?: string) => auth.api(userId);

  const createUser = () => auth.createUser('CUSTOMER');

  /** A fresh active variant with `stock` units on hand. */
  const createVariant = async (stock: number, priceMinor = 1000) => {
    const n = ++counter;
    const product = (
      await api()
        .post('/products')
        .field(
          'data',
          JSON.stringify({ name: `Order Laptop ${suffix}-${n}`, brandId, categoryId, specs }),
        )
        .expect(201)
    ).body as { id: string };
    const variant = (
      await api()
        .post(`/products/${product.id}/variants`)
        .field(
          'data',
          JSON.stringify({ sku: `ORD-${suffix}-${n}`, name: 'Order variant', priceMinor }),
        )
        .expect(201)
    ).body as { id: string };
    if (stock > 0) {
      await api()
        .post(`/inventory/variants/${variant.id}/stock-in`)
        .send({ quantity: stock })
        .expect(201);
    }
    return variant.id;
  };

  const addToCart = (userId: string, variantId: string, quantity: number) =>
    api(userId).post('/cart/items').send({ variantId, quantity }).expect(200);

  const checkout = async (
    userId: string,
    key: string = randomUUID(),
    body: object = { shippingAddress: address },
  ) => {
    const res = await api(userId).post('/orders/checkout').set('Idempotency-Key', key).send(body);
    if (res.status === 201) placed.push((res.body as CheckoutBody).order.id);
    return res;
  };

  /** Simulates the Phase 10 webhook: consume the reservation and mark the order paid. */
  const pay = (orderId: string) =>
    prisma.$transaction(async (tx) => {
      const lines = await reservations.consume(tx, orderId);
      if (lines.length === 0) return false;
      await tx.order.update({
        where: { id: orderId },
        data: { status: 'PAID', paidAt: new Date() },
      });
      return true;
    });

  const stockRow = (variantId: string) =>
    prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId },
      select: { onHand: true, reserved: true },
    });

  it('requires auth, an Idempotency-Key and a valid address', async () => {
    await auth.api('anon').post('/orders/checkout').send({ shippingAddress: address }).expect(401);

    const user = await createUser();
    await addToCart(user, await createVariant(5), 1);
    await api(user).post('/orders/checkout').send({ shippingAddress: address }).expect(400);
    await api(user)
      .post('/orders/checkout')
      .set('Idempotency-Key', 'short')
      .send({ shippingAddress: address })
      .expect(400);
    expect(
      (await checkout(user, randomUUID(), { shippingAddress: { ...address, country: 'fr' } }))
        .status,
    ).toBe(400);
    expect((await checkout(user, randomUUID(), {})).status).toBe(400);
    expect(await prisma.order.count({ where: { userId: user } })).toBe(0);
  });

  it('rejects an empty cart', async () => {
    const user = await createUser();
    expect((await checkout(user)).status).toBe(400);
  });

  it('checks out: snapshot, shipping, reservation, ledger entry, and keeps the cart', async () => {
    const user = await createUser();
    const variant = await createVariant(5);
    await addToCart(user, variant, 2);

    const res = await checkout(user);
    expect(res.status).toBe(201);
    const { replayed, order } = res.body as CheckoutBody;
    expect(replayed).toBe(false);
    expect(order).toMatchObject({
      status: 'PENDING_PAYMENT',
      subtotalMinor: 2000,
      shippingMinor: 990,
      totalMinor: 2990,
      currency: 'EUR',
    });
    expect(order.orderNumber).toMatch(/^VLX-\d{8}-[0-9A-Z]{8}$/);
    expect(order.items).toHaveLength(1);
    expect(order.items[0]).toMatchObject({
      variantId: variant,
      unitPriceMinor: 1000,
      quantity: 2,
      lineTotalMinor: 2000,
    });
    expect(order.items[0].sku).toMatch(/^ORD-/);

    const ttl = new Date(order.expiresAt!).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(31 * 60_000);

    expect(await stockRow(variant)).toEqual({ onHand: 5, reserved: 2 });
    const reservation = await prisma.stockReservation.findFirstOrThrow({
      where: { orderId: order.id },
      select: { status: true, quantity: true },
    });
    expect(reservation).toEqual({ status: 'ACTIVE', quantity: 2 });
    expect(
      await prisma.inventoryMovement.count({
        where: { variantId: variant, type: 'RESERVE', referenceId: order.id },
      }),
    ).toBe(1);
    expect(
      await prisma.outboxEvent.count({ where: { aggregateId: order.id, type: 'order.created' } }),
    ).toBe(1);

    const cart = (await api(user).get('/cart').expect(200)).body as { itemCount: number };
    expect(cart.itemCount).toBe(2); // kept until payment (Phase 10)
  });

  it('applies free shipping from the threshold', async () => {
    const user = await createUser();
    await addToCart(user, await createVariant(2, 50_000), 1);
    const { order } = (await checkout(user)).body as CheckoutBody;
    expect(order).toMatchObject({ subtotalMinor: 50_000, shippingMinor: 0, totalMinor: 50_000 });
  });

  it('refuses a total above the Stripe maximum', async () => {
    const user = await createUser();
    await addToCart(user, await createVariant(10, 10_000_000), 10); // 100,000,000 > 99,999,999
    expect((await checkout(user)).status).toBe(400);
    expect(await prisma.order.count({ where: { userId: user } })).toBe(0);
  });

  it('keeps the order price when the catalog price changes later', async () => {
    const user = await createUser();
    const variant = await createVariant(5);
    await addToCart(user, variant, 1);
    const { order } = (await checkout(user)).body as CheckoutBody;

    await api()
      .patch(`/variants/${variant}`)
      .field('data', JSON.stringify({ priceMinor: 2000 }))
      .expect(200);

    const fetched = (await api(user).get(`/orders/${order.id}`).expect(200)).body as OrderBody;
    expect(fetched.items[0].unitPriceMinor).toBe(1000);
    expect(fetched.totalMinor).toBe(order.totalMinor);
    const cart = (await api(user).get('/cart').expect(200)).body as { subtotalMinor: number };
    expect(cart.subtotalMinor).toBe(2000); // the cart shows live prices, the order does not
  });

  it('is idempotent: the same key replays with 200 and reserves once', async () => {
    const user = await createUser();
    const variant = await createVariant(5);
    await addToCart(user, variant, 2);
    const key = randomUUID();

    const first = await checkout(user, key);
    const second = await checkout(user, key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect((second.body as CheckoutBody).replayed).toBe(true);
    expect((second.body as CheckoutBody).order.id).toBe((first.body as CheckoutBody).order.id);
    expect(await prisma.order.count({ where: { userId: user } })).toBe(1);
    expect(await stockRow(variant)).toEqual({ onHand: 5, reserved: 2 });
  });

  it('is idempotent under parallel duplicates', async () => {
    const user = await createUser();
    const variant = await createVariant(5);
    await addToCart(user, variant, 2);
    const key = randomUUID();

    const results = await Promise.all(Array.from({ length: 5 }, () => checkout(user, key)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.every((r) => r.status === 201 || r.status === 200)).toBe(true);
    expect(await prisma.order.count({ where: { userId: user } })).toBe(1);
    expect(await stockRow(variant)).toEqual({ onHand: 5, reserved: 2 });
  });

  it('allows one unpaid order per user, even with parallel different keys', async () => {
    const user = await createUser();
    const variant = await createVariant(5);
    await addToCart(user, variant, 1);

    const results = await Promise.all(Array.from({ length: 4 }, () => checkout(user)));
    const winners = results.filter((r) => r.status === 201);
    const losers = results.filter((r) => r.status === 409);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(3);

    const orderId = (winners[0].body as CheckoutBody).order.id;
    expect(losers[0].body).toMatchObject({ orderId });
    expect(await stockRow(variant)).toEqual({ onHand: 5, reserved: 1 });
  });

  it('returns 409 with the available stock when there is not enough, and creates nothing', async () => {
    const user = await createUser();
    const variant = await createVariant(5);
    await addToCart(user, variant, 3);
    await api()
      .post(`/inventory/variants/${variant}/stock-out`)
      .send({ quantity: 3, reason: 'Order shortage test' })
      .expect(201);

    const res = await checkout(user);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ variantId: variant, available: 2, requested: 3 });
    expect(await prisma.order.count({ where: { userId: user } })).toBe(0);
    expect(await stockRow(variant)).toEqual({ onHand: 2, reserved: 0 });
  });

  it('is all-or-nothing across lines', async () => {
    const user = await createUser();
    const enough = await createVariant(5);
    const short = await createVariant(3);
    await addToCart(user, enough, 1);
    await addToCart(user, short, 3);
    await api()
      .post(`/inventory/variants/${short}/stock-out`)
      .send({ quantity: 2, reason: 'Order shortage test' })
      .expect(201);

    expect((await checkout(user)).status).toBe(409);
    expect(await prisma.order.count({ where: { userId: user } })).toBe(0);
    expect(await stockRow(enough)).toEqual({ onHand: 5, reserved: 0 });
    expect(await stockRow(short)).toEqual({ onHand: 1, reserved: 0 });
  });

  it('refuses unavailable items and lists them', async () => {
    const user = await createUser();
    const variant = await createVariant(5);
    await addToCart(user, variant, 1);
    await api().delete(`/variants/${variant}`).expect(204);

    const res = await checkout(user);
    expect(res.status).toBe(409);
    expect(
      (res.body as { unavailable: { variantId: string }[] }).unavailable.map((u) => u.variantId),
    ).toEqual([variant]);
    expect(await prisma.order.count({ where: { userId: user } })).toBe(0);
  });

  it('never oversells the last units across parallel checkouts', async () => {
    const variant = await createVariant(2);
    const users = await Promise.all(Array.from({ length: 5 }, () => createUser()));
    for (const user of users) await addToCart(user, variant, 1);

    const results = await Promise.all(users.map((user) => checkout(user)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    const failed = results.filter((r) => r.status === 409);
    expect(failed).toHaveLength(3);
    expect(failed[0].body).toMatchObject({ available: 0 });

    expect(await stockRow(variant)).toEqual({ onHand: 2, reserved: 2 });
    const active = await prisma.stockReservation.aggregate({
      where: { variantId: variant, status: 'ACTIVE' },
      _sum: { quantity: true },
    });
    expect(active._sum.quantity).toBe(2);
    expect(await prisma.order.count({ where: { userId: { in: users } } })).toBe(2);
  });

  it('cancels an unpaid order: stock released, idempotent, user can order again', async () => {
    const user = await createUser();
    const variant = await createVariant(5);
    await addToCart(user, variant, 2);
    const { order } = (await checkout(user)).body as CheckoutBody;

    const cancelled = (await api(user).post(`/orders/${order.id}/cancel`).expect(201))
      .body as OrderBody;
    expect(cancelled).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'CUSTOMER_CANCELLED',
      expiresAt: null,
    });
    expect(await stockRow(variant)).toEqual({ onHand: 5, reserved: 0 });
    const reservation = await prisma.stockReservation.findFirstOrThrow({
      where: { orderId: order.id },
      select: { status: true },
    });
    expect(reservation.status).toBe('RELEASED');
    expect(
      await prisma.outboxEvent.count({ where: { aggregateId: order.id, type: 'order.cancelled' } }),
    ).toBe(1);

    await api(user).post(`/orders/${order.id}/cancel`).expect(201); // idempotent
    expect((await checkout(user)).status).toBe(201); // the open-order lock is gone
  });

  it('lets a user order again after their unpaid order expired', async () => {
    const user = await createUser();
    const variant = await createVariant(5);
    await addToCart(user, variant, 1);
    const { order } = (await checkout(user)).body as CheckoutBody;
    expect((await checkout(user)).status).toBe(409);

    await prisma.$executeRaw`UPDATE stock_reservations SET expires_at = now() - interval '1 minute' WHERE order_id = ${order.id}::uuid`;
    await api().post('/reservations/expire-due').expect(200);

    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { status: true, cancelReason: true },
    });
    expect(row).toEqual({ status: 'CANCELLED', cancelReason: 'RESERVATION_EXPIRED' });
    expect((await checkout(user)).status).toBe(201);
  });

  it('refuses to cancel a paid order, ships it once, and refuses to ship an unpaid one', async () => {
    const user = await createUser();
    const variant = await createVariant(5);
    await addToCart(user, variant, 2);
    const { order } = (await checkout(user)).body as CheckoutBody;

    await api().post(`/admin/orders/${order.id}/ship`).expect(409); // not paid yet
    expect(await pay(order.id)).toBe(true);
    expect(await stockRow(variant)).toEqual({ onHand: 3, reserved: 0 });

    await api(user).post(`/orders/${order.id}/cancel`).expect(409);

    const shipped = (await api().post(`/admin/orders/${order.id}/ship`).expect(200))
      .body as OrderBody;
    expect(shipped.status).toBe('SHIPPED');
    expect(shipped.shippedAt).not.toBeNull();
    await api().post(`/admin/orders/${order.id}/ship`).expect(200); // idempotent
    expect(
      await prisma.outboxEvent.count({ where: { aggregateId: order.id, type: 'order.shipped' } }),
    ).toBe(1);
    await api(user).post(`/orders/${order.id}/cancel`).expect(409);
    await api().post(`/admin/orders/${randomUUID()}/ship`).expect(404);
  });

  it('stays consistent when cancellation races payment: exactly one wins', async () => {
    for (let i = 0; i < 5; i++) {
      const user = await createUser();
      const variant = await createVariant(5);
      await addToCart(user, variant, 2);
      const { order } = (await checkout(user)).body as CheckoutBody;

      const [cancelRes, paid] = await Promise.all([
        api(user).post(`/orders/${order.id}/cancel`),
        pay(order.id),
      ]);

      const row = await prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        select: { status: true },
      });
      if (paid) {
        expect(cancelRes.status).toBe(409);
        expect(row.status).toBe('PAID');
        expect(await stockRow(variant)).toEqual({ onHand: 3, reserved: 0 });
      } else {
        expect(cancelRes.status).toBe(201);
        expect(row.status).toBe('CANCELLED');
        expect(await stockRow(variant)).toEqual({ onHand: 5, reserved: 0 });
      }
    }
  });

  it('shows an order only to its owner, lists with filters, and supports admin search', async () => {
    const alice = await createUser();
    const bob = await createUser();
    const variant = await createVariant(5);
    await addToCart(alice, variant, 1);
    const { order } = (await checkout(alice)).body as CheckoutBody;

    await api(alice).get(`/orders/${order.id}`).expect(200);
    await api(bob).get(`/orders/${order.id}`).expect(404);
    await api(bob).post(`/orders/${order.id}/cancel`).expect(404);

    const mine = (await api(alice).get('/orders').expect(200)).body as ListBody;
    expect(mine.items.map((o) => o.id)).toEqual([order.id]);
    const bobs = (await api(bob).get('/orders').expect(200)).body as ListBody;
    expect(bobs.items).toEqual([]);
    const paid = (await api(alice).get('/orders').query({ status: 'PAID' }).expect(200))
      .body as ListBody;
    expect(paid.items).toEqual([]);
    await api(alice).get('/orders').query({ status: 'NOPE' }).expect(400);

    const found = (await api().get('/admin/orders').query({ q: order.orderNumber }).expect(200))
      .body as ListBody;
    expect(found.items).toHaveLength(1);
    expect(found.items[0].customer?.email).toContain('@voltix.test');
    const detail = (await api().get(`/admin/orders/${order.id}`).expect(200)).body as OrderBody;
    expect(detail.id).toBe(order.id);
    await api().get(`/admin/orders/${randomUUID()}`).expect(404);
  });
});
