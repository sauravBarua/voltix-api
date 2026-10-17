import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { API_PREFIX, configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { ReservationsService } from '../src/reservations/reservations.service';

type Ref = { id: string; slug: string };
type ListBody = {
  items: { orderId: string; variantId: string; sku: string; status: string; quantity: number }[];
};

describe('Reservations (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let reservations: ReservationsService;
  let brandId: string;
  let categoryId: string;
  let counter = 0;
  const createdOrders: string[] = [];
  const suffix = Date.now().toString(36).toUpperCase();
  const specs = { cpu: 'Test CPU', screenSizeInch: 15.6, os: 'Windows 11' };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
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
    // Free whatever the tests left active, and close the orders, so the dev database stays clean
    for (const orderId of createdOrders) {
      await prisma.$transaction(async (tx) => {
        await reservations.release(tx, orderId);
        await tx.order.updateMany({
          where: { id: orderId, status: 'PENDING_PAYMENT' },
          data: { status: 'CANCELLED', cancelReason: 'TEST_CLEANUP', cancelledAt: new Date() },
        });
      });
    }
    await app.close();
  });

  const api = () => {
    const server = app.getHttpServer();
    const url = (p: string) => `/${API_PREFIX}${p}`;
    return {
      get: (p: string) => request(server).get(url(p)),
      post: (p: string) => request(server).post(url(p)),
    };
  };

  /** A fresh active variant with `stock` units on hand (through the real endpoints). */
  const createVariant = async (stock: number) => {
    const n = ++counter;
    const product = (
      await api()
        .post('/products')
        .field(
          'data',
          JSON.stringify({ name: `Reservation Laptop ${suffix}-${n}`, brandId, categoryId, specs }),
        )
        .expect(201)
    ).body as { id: string };
    const variant = (
      await api()
        .post(`/products/${product.id}/variants`)
        .field(
          'data',
          JSON.stringify({
            sku: `RSV-${suffix}-${n}`,
            name: 'Reservation variant',
            priceMinor: 1000,
          }),
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

  /** Phase 9 creates orders through checkout; here a minimal row is enough (one user per order). */
  const createOrder = async () => {
    const n = ++counter;
    const user = await prisma.user.create({
      data: { email: `reservations-${suffix}-${n}@voltix.test`, name: 'Reservations Test' },
      select: { id: true },
    });
    const order = await prisma.order.create({
      data: {
        orderNumber: `RSV-${suffix}-${n}`,
        userId: user.id,
        subtotalMinor: 1000,
        totalMinor: 1000,
        idempotencyKey: randomUUID(),
        shippingAddress: {},
      },
      select: { id: true },
    });
    createdOrders.push(order.id);
    return order.id;
  };

  const reserve = (orderId: string, lines: { variantId: string; quantity: number }[]) =>
    prisma.$transaction((tx) => reservations.reserve(tx, { orderId, lines }));
  const release = (orderId: string) =>
    prisma.$transaction((tx) => reservations.release(tx, orderId));
  const consume = (orderId: string) =>
    prisma.$transaction((tx) => reservations.consume(tx, orderId));

  const stockRow = (variantId: string) =>
    prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId },
      select: { onHand: true, reserved: true },
    });
  const statusOf = async (orderId: string, variantId: string) =>
    (
      await prisma.stockReservation.findUniqueOrThrow({
        where: { orderId_variantId: { orderId, variantId } },
        select: { status: true },
      })
    ).status;
  const movements = (variantId: string, type: 'RESERVE' | 'RELEASE' | 'SALE') =>
    prisma.inventoryMovement.findMany({ where: { variantId, type } });

  it('reserves stock: reserved goes up, on-hand stays, a RESERVE movement is written', async () => {
    const v = await createVariant(5);
    const o = await createOrder();
    const res = await reserve(o, [{ variantId: v, quantity: 2 }]);

    expect(res.replayed).toBe(false);
    expect(res.reservations).toHaveLength(1);
    expect(res.reservations[0]).toMatchObject({ status: 'ACTIVE', quantity: 2, orderId: o });
    expect(await stockRow(v)).toEqual({ onHand: 5, reserved: 2 });

    const mv = await movements(v, 'RESERVE');
    expect(mv).toHaveLength(1);
    expect(mv[0]).toMatchObject({
      deltaOnHand: 0,
      deltaReserved: 2,
      referenceType: 'ORDER',
      referenceId: o,
    });

    const ttl = new Date(res.reservations[0].expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(31 * 60_000); // default 32 min, always above Stripe's 30
    expect(ttl).toBeLessThan(33 * 60_000);

    const inv = (await api().get(`/inventory/variants/${v}`).expect(200)).body as {
      available: number;
    };
    expect(inv.available).toBe(3);
  });

  it('is all-or-nothing: one short line rolls back the whole reservation', async () => {
    const a = await createVariant(5);
    const b = await createVariant(1);
    const o = await createOrder();

    await expect(
      reserve(o, [
        { variantId: a, quantity: 2 },
        { variantId: b, quantity: 2 },
      ]),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(await stockRow(a)).toEqual({ onHand: 5, reserved: 0 });
    expect(await stockRow(b)).toEqual({ onHand: 1, reserved: 0 });
    expect(await prisma.stockReservation.count({ where: { orderId: o } })).toBe(0);
    expect(await movements(a, 'RESERVE')).toHaveLength(0);
  });

  it('is idempotent per order: a second reserve replays and reserves nothing more', async () => {
    const v = await createVariant(5);
    const o = await createOrder();
    await reserve(o, [{ variantId: v, quantity: 2 }]);
    const again = await reserve(o, [{ variantId: v, quantity: 2 }]);

    expect(again.replayed).toBe(true);
    expect(again.reservations).toHaveLength(1);
    expect(await stockRow(v)).toEqual({ onHand: 5, reserved: 2 });
    expect(await movements(v, 'RESERVE')).toHaveLength(1);
  });

  it('rejects bad input and unknown variants', async () => {
    const v = await createVariant(5);
    const o = await createOrder();
    await expect(reserve(o, [{ variantId: v, quantity: 0 }])).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      reserve(o, [
        { variantId: v, quantity: 1 },
        { variantId: v, quantity: 1 },
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(reserve(o, [{ variantId: randomUUID(), quantity: 1 }])).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('never oversells under concurrent reservations, and reserved equals the active reservations', async () => {
    const v = await createVariant(5);
    const orders = await Promise.all(Array.from({ length: 12 }, () => createOrder()));

    const results = await Promise.allSettled(
      orders.map((o) => reserve(o, [{ variantId: v, quantity: 1 }])),
    );
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
    expect(rejected).toHaveLength(7);
    expect(
      rejected.every((r) => (r as PromiseRejectedResult).reason instanceof ConflictException),
    ).toBe(true);

    expect(await stockRow(v)).toEqual({ onHand: 5, reserved: 5 });
    const active = await prisma.stockReservation.aggregate({
      where: { variantId: v, status: 'ACTIVE' },
      _sum: { quantity: true },
    });
    expect(active._sum.quantity).toBe(5);
  });

  it('releases once; repeating or consuming afterwards is a no-op', async () => {
    const v = await createVariant(5);
    const o = await createOrder();
    await reserve(o, [{ variantId: v, quantity: 3 }]);

    expect(await release(o)).toEqual([{ variantId: v, quantity: 3 }]);
    expect(await statusOf(o, v)).toBe('RELEASED');
    expect(await stockRow(v)).toEqual({ onHand: 5, reserved: 0 });

    const mv = await movements(v, 'RELEASE');
    expect(mv).toHaveLength(1);
    expect(mv[0]).toMatchObject({ deltaOnHand: 0, deltaReserved: -3 });

    expect(await release(o)).toEqual([]);
    expect(await consume(o)).toEqual([]);
    expect(await stockRow(v)).toEqual({ onHand: 5, reserved: 0 });
  });

  it('consumes a reservation into a sale, and the ledger still adds up', async () => {
    const v = await createVariant(5);
    const o = await createOrder();
    await reserve(o, [{ variantId: v, quantity: 3 }]);

    expect(await consume(o)).toEqual([{ variantId: v, quantity: 3 }]);
    expect(await statusOf(o, v)).toBe('CONSUMED');
    expect(await stockRow(v)).toEqual({ onHand: 2, reserved: 0 });

    const sale = await movements(v, 'SALE');
    expect(sale).toHaveLength(1);
    expect(sale[0]).toMatchObject({ deltaOnHand: -3, deltaReserved: -3 });

    expect(await release(o)).toEqual([]); // a paid order cannot be released
    expect(await stockRow(v)).toEqual({ onHand: 2, reserved: 0 });

    const sum = await prisma.inventoryMovement.aggregate({
      where: { variantId: v },
      _sum: { deltaOnHand: true },
    });
    expect(sum._sum.deltaOnHand).toBe(2); // +5 stock-in, -3 sale
  });

  it('expires only due reservations, cancels their order, and is repeatable', async () => {
    const v = await createVariant(5);
    const dueOrder = await createOrder();
    const freshOrder = await createOrder();
    await reserve(dueOrder, [{ variantId: v, quantity: 2 }]);
    await reserve(freshOrder, [{ variantId: v, quantity: 1 }]);
    await prisma.$executeRaw`UPDATE stock_reservations SET expires_at = now() - interval '1 minute' WHERE order_id = ${dueOrder}::uuid`;

    const res = await api().post('/reservations/expire-due').expect(200);
    const body = res.body as { expiredOrders: number; failedOrders: number };
    expect(body.expiredOrders).toBeGreaterThanOrEqual(1);
    expect(body.failedOrders).toBe(0);

    expect(await statusOf(dueOrder, v)).toBe('EXPIRED');
    expect(await statusOf(freshOrder, v)).toBe('ACTIVE');
    expect(await stockRow(v)).toEqual({ onHand: 5, reserved: 1 });

    const due = await prisma.order.findUniqueOrThrow({
      where: { id: dueOrder },
      select: { status: true, cancelReason: true, cancelledAt: true },
    });
    expect(due).toMatchObject({ status: 'CANCELLED', cancelReason: 'RESERVATION_EXPIRED' });
    expect(due.cancelledAt).not.toBeNull();
    const fresh = await prisma.order.findUniqueOrThrow({
      where: { id: freshOrder },
      select: { status: true },
    });
    expect(fresh.status).toBe('PENDING_PAYMENT');

    await api().post('/reservations/expire-due').expect(200); // nothing changes the second time
    expect(await stockRow(v)).toEqual({ onHand: 5, reserved: 1 });
  });

  it('stays consistent when payment (consume) races expiry: exactly one wins', async () => {
    for (let i = 0; i < 5; i++) {
      const v = await createVariant(5);
      const o = await createOrder();
      await reserve(o, [{ variantId: v, quantity: 2 }]);
      await prisma.$executeRaw`UPDATE stock_reservations SET expires_at = now() - interval '1 minute' WHERE order_id = ${o}::uuid`;

      const [consumed] = await Promise.all([consume(o), reservations.expireDue()]);

      const status = await statusOf(o, v);
      const stock = await stockRow(v);
      if (status === 'CONSUMED') {
        expect(consumed).toHaveLength(1);
        expect(stock).toEqual({ onHand: 3, reserved: 0 });
      } else {
        expect(status).toBe('EXPIRED');
        expect(consumed).toEqual([]);
        expect(stock).toEqual({ onHand: 5, reserved: 0 });
      }
    }
  });

  it('lists reservations with filters and validates the query', async () => {
    const v = await createVariant(5);
    const o = await createOrder();
    await reserve(o, [{ variantId: v, quantity: 1 }]);

    const body = (
      await api().get('/reservations').query({ orderId: o, status: 'ACTIVE' }).expect(200)
    ).body as ListBody;
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      orderId: o,
      variantId: v,
      status: 'ACTIVE',
      quantity: 1,
    });
    expect(body.items[0].sku).toMatch(/^RSV-/);

    await api().get('/reservations').query({ status: 'NOPE' }).expect(400);
    await api().get('/reservations').query({ orderId: 'not-a-uuid' }).expect(400);
  });
});
