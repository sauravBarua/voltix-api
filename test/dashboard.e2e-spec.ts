import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import type { OrderStatus } from '../src/generated/prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { TestAuth } from './helpers/auth';

jest.setTimeout(60_000);

type Ref = { id: string; slug: string };
type Kpi = {
  revenueMinor: number;
  refundsMinor: number;
  netRevenueMinor: number;
  orders: number;
  averageOrderValueMinor: number;
  unitsSold: number;
};
type KpisBody = { current: Kpi; previous: Kpi; currency: string };
type Point = {
  bucket: string;
  orders: number;
  revenueMinor: number;
  refundsMinor: number;
  unitsSold: number;
};
type Item = {
  id: string;
  name: string;
  sku?: string;
  unitsSold: number;
  revenueMinor: number;
  orders: number;
  sharePercent?: number;
};

const range = { from: '2001-03-01T00:00:00Z', to: '2001-04-01T00:00:00Z', tz: 'UTC' };

describe('Dashboard (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let redis: RedisService;
  let auth: TestAuth;
  let dellId: string;
  let appleId: string;
  let laptopsId: string;
  let smartphonesId: string;
  let orderC = '';
  const suffix = Date.now().toString(36).toUpperCase();

  const cleanup = async () => {
    await prisma.payment.deleteMany({ where: { order: { orderNumber: { startsWith: 'DSH-' } } } });
    await prisma.order.deleteMany({ where: { orderNumber: { startsWith: 'DSH-' } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: 'dsh-' } } });
    await prisma.productVariant.deleteMany({ where: { sku: { startsWith: 'DSHF-' } } });
    await prisma.product.deleteMany({ where: { slug: { startsWith: 'dsh-fixture-' } } });
  };
  const clearCache = async () => {
    const keys = await redis.client.keys('cache:dash:*');
    if (keys.length) await redis.client.del(...keys);
  };

  const makeProduct = async (key: string, brandId: string, categoryId: string) => {
    const product = await prisma.product.create({
      data: {
        name: `Dashboard ${key} ${suffix}`,
        slug: `dsh-fixture-${key.toLowerCase()}-${suffix.toLowerCase()}`,
        brandId,
        categoryId,
        specs: {},
        variants: {
          create: {
            sku: `DSHF-${key}-${suffix}`,
            name: `${key} variant`,
            priceMinor: key === 'P1' ? 1000 : 500,
          },
        },
      },
      select: { variants: { select: { id: true } } },
    });
    return product.variants[0].id;
  };

  const makeOrder = async (
    n: string,
    o: {
      status: OrderStatus;
      paidAt: Date | null;
      createdAt: Date;
      lines: [string, number, number][];
      shipping: number;
      refunded?: number;
    },
  ) => {
    const user = await prisma.user.create({
      data: { email: `dsh-${suffix}-${n}@voltix.test`, name: `Dash ${n}` },
      select: { id: true },
    });
    const subtotal = o.lines.reduce((sum, [, price, qty]) => sum + price * qty, 0);
    const total = subtotal + o.shipping;
    const order = await prisma.order.create({
      data: {
        orderNumber: `DSH-${suffix}-${n}`,
        userId: user.id,
        status: o.status,
        subtotalMinor: subtotal,
        shippingMinor: o.shipping,
        totalMinor: total,
        idempotencyKey: randomUUID(),
        shippingAddress: {},
        paidAt: o.paidAt,
        createdAt: o.createdAt,
        items: {
          create: o.lines.map(([variantId, price, qty]) => ({
            variantId,
            skuSnapshot: 'x',
            nameSnapshot: 'x',
            unitPriceMinor: price,
            quantity: qty,
          })),
        },
      },
      select: { id: true },
    });
    if (o.paidAt) {
      await prisma.payment.create({
        data: {
          orderId: order.id,
          status: o.refunded ? 'PARTIALLY_REFUNDED' : 'PAID',
          stripeSessionId: `cs_test_dsh_${randomUUID().replaceAll('-', '')}`,
          amountMinor: total,
          refundedMinor: o.refunded ?? 0,
          idempotencyKey: `dsh:${randomUUID()}`,
        },
      });
    }
    return order.id;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
    auth = await TestAuth.create(app);
    await cleanup();

    const brands = (await auth.api().get('/brands').expect(200)).body as Ref[];
    const categories = (await auth.api().get('/categories').expect(200)).body as Ref[];
    dellId = brands.find((b) => b.slug === 'dell')!.id;
    appleId = brands.find((b) => b.slug === 'apple')!.id;
    laptopsId = categories.find((c) => c.slug === 'laptops')!.id;
    smartphonesId = categories.find((c) => c.slug === 'smartphones')!.id;

    const p1 = await makeProduct('P1', dellId, laptopsId); // 1000, Dell, Laptops
    const p2 = await makeProduct('P2', appleId, smartphonesId); // 500, Apple, Smartphones
    const at = (d: string) => new Date(`2001-03-${d}Z`);

    await makeOrder('A', {
      status: 'PAID',
      paidAt: at('05T12:00:00'),
      createdAt: at('05T11:00:00'),
      lines: [
        [p1, 1000, 2],
        [p2, 500, 1],
      ],
      shipping: 990,
    }); // total 3490
    await makeOrder('B', {
      status: 'PARTIALLY_REFUNDED',
      paidAt: at('06T12:00:00'),
      createdAt: at('06T11:00:00'),
      lines: [[p1, 1000, 1]],
      shipping: 990,
      refunded: 500,
    }); // total 1990
    orderC = await makeOrder('C', {
      status: 'SHIPPED',
      paidAt: at('12T12:00:00'),
      createdAt: at('12T11:00:00'),
      lines: [[p2, 500, 4]],
      shipping: 990,
    }); // total 2990
    await makeOrder('D', {
      status: 'CANCELLED',
      paidAt: null,
      createdAt: at('06T13:00:00'),
      lines: [[p1, 1000, 1]],
      shipping: 990,
    });
    await makeOrder('E', {
      status: 'PENDING_PAYMENT',
      paidAt: null,
      createdAt: at('07T10:00:00'),
      lines: [[p2, 500, 1]],
      shipping: 990,
    });
    await clearCache();
  });

  afterAll(async () => {
    await cleanup();
    await clearCache();
    await app?.close();
  });

  const get = (path: string, query: Record<string, string | number> = {}, who?: string) =>
    auth.api(who).get(`/admin/dashboard${path}`).query(query);

  // ── access ──
  it('shows money widgets to admins only and inventory widgets to staff', async () => {
    const customer = await auth.createUser('CUSTOMER');
    const operator = await auth.createUser('INVENTORY_OPERATOR');
    const money = [
      '/kpis',
      '/sales-over-time',
      '/orders-by-status',
      '/top-products',
      '/sales-breakdown',
      '/recent-orders',
      '/export/sales.csv',
      '/export/orders.csv',
    ];
    const stock = [
      '/inventory/summary',
      '/inventory/low-stock',
      '/inventory/out-of-stock',
      '/inventory/movements',
    ];

    for (const path of [...money, ...stock]) await get(path, {}, 'anon').expect(401);
    for (const path of [...money, ...stock]) await get(path, {}, customer).expect(403);
    for (const path of money) await get(path, {}, operator).expect(403);
    for (const path of stock) await get(path, {}, operator).expect(200);
    for (const path of [...money, ...stock]) await get(path).expect(200);
  });

  it('validates ranges, time zones and filters', async () => {
    await get('/kpis', { from: '2001-04-01T00:00:00Z', to: '2001-03-01T00:00:00Z' }).expect(400);
    await get('/kpis', { from: '2001-03-01T00:00:00Z', to: '2001-03-01T00:00:00Z' }).expect(400);
    await get('/kpis', { from: '2001-01-01T00:00:00Z', to: '2003-01-01T00:00:00Z' }).expect(400); // over 366 days
    await get('/kpis', { ...range, tz: 'Mars/Phobos' }).expect(400);
    await get('/kpis', { from: 'yesterday' }).expect(400);
    await get('/sales-over-time', { ...range, granularity: 'hour' }).expect(400);
    await get('/top-products', { ...range, limit: 0 }).expect(400);
    await get('/top-products', { ...range, by: 'margin' }).expect(400);
    await get('/sales-breakdown', { ...range, group: 'colour' }).expect(400);
  });

  // ── sales widgets ──
  it('computes KPIs from paid orders, with refunds and the previous period', async () => {
    const body = (await get('/kpis', range).expect(200)).body as KpisBody;
    expect(body.currency).toBe('EUR');
    expect(body.current).toEqual({
      revenueMinor: 8470, // 3490 + 1990 + 2990: cancelled and pending orders do not count
      refundsMinor: 500,
      netRevenueMinor: 7970,
      orders: 3,
      averageOrderValueMinor: 2823,
      unitsSold: 8,
    });
    expect(body.previous).toEqual({
      revenueMinor: 0,
      refundsMinor: 0,
      netRevenueMinor: 0,
      orders: 0,
      averageOrderValueMinor: 0,
      unitsSold: 0,
    });
  });

  it('buckets sales per day, week and month, with empty buckets as zeros', async () => {
    const day = (
      (await get('/sales-over-time', { ...range, granularity: 'day' }).expect(200)).body as {
        points: Point[];
      }
    ).points;
    expect(day).toHaveLength(31);
    expect([day[0].bucket, day[30].bucket]).toEqual(['2001-03-01', '2001-03-31']);
    expect(day.filter((p) => p.orders > 0)).toEqual([
      { bucket: '2001-03-05', orders: 1, revenueMinor: 3490, refundsMinor: 0, unitsSold: 3 },
      { bucket: '2001-03-06', orders: 1, revenueMinor: 1990, refundsMinor: 500, unitsSold: 1 },
      { bucket: '2001-03-12', orders: 1, revenueMinor: 2990, refundsMinor: 0, unitsSold: 4 },
    ]);

    const week = (
      (await get('/sales-over-time', { ...range, granularity: 'week' }).expect(200)).body as {
        points: Point[];
      }
    ).points;
    expect(week.map((p) => p.bucket)).toEqual([
      '2001-02-26',
      '2001-03-05',
      '2001-03-12',
      '2001-03-19',
      '2001-03-26',
    ]); // Monday starts
    expect(week[1]).toEqual({
      bucket: '2001-03-05',
      orders: 2,
      revenueMinor: 5480,
      refundsMinor: 500,
      unitsSold: 4,
    });
    expect(week[2]).toEqual({
      bucket: '2001-03-12',
      orders: 1,
      revenueMinor: 2990,
      refundsMinor: 0,
      unitsSold: 4,
    });

    const month = (
      (await get('/sales-over-time', { ...range, granularity: 'month' }).expect(200)).body as {
        points: Point[];
      }
    ).points;
    expect(month).toEqual([
      { bucket: '2001-03-01', orders: 3, revenueMinor: 8470, refundsMinor: 500, unitsSold: 8 },
    ]);
  });

  it('counts orders created in the range per status, listing every status', async () => {
    const body = (await get('/orders-by-status', range).expect(200)).body as {
      total: number;
      byStatus: { status: string; count: number }[];
    };
    expect(body.byStatus).toHaveLength(7);
    expect(body.total).toBe(5);
    const counts = Object.fromEntries(body.byStatus.map((s) => [s.status, s.count]));
    expect(counts).toEqual({
      PENDING_PAYMENT: 1,
      PAID: 1,
      SHIPPED: 1,
      CANCELLED: 1,
      PAYMENT_FAILED: 0,
      REFUNDED: 0,
      PARTIALLY_REFUNDED: 1,
    });
  });

  it('ranks top products by revenue or units, per product or variant', async () => {
    const byRevenue = (
      (await get('/top-products', { ...range, by: 'revenue' }).expect(200)).body as {
        items: Item[];
      }
    ).items;
    expect(byRevenue.map((i) => [i.name, i.revenueMinor, i.unitsSold, i.orders])).toEqual([
      [`Dashboard P1 ${suffix}`, 3000, 3, 2],
      [`Dashboard P2 ${suffix}`, 2500, 5, 2],
    ]);

    const byUnits = (
      (await get('/top-products', { ...range, by: 'units' }).expect(200)).body as { items: Item[] }
    ).items;
    expect(byUnits[0].name).toBe(`Dashboard P2 ${suffix}`);

    const variants = (
      (await get('/top-products', { ...range, level: 'variant', limit: 1 }).expect(200)).body as {
        items: Item[];
      }
    ).items;
    expect(variants).toHaveLength(1);
    expect(variants[0].sku).toBe(`DSHF-P1-${suffix}`);
  });

  it('breaks revenue down by category and by brand with shares', async () => {
    const category = (await get('/sales-breakdown', { ...range, group: 'category' }).expect(200))
      .body as { totalRevenueMinor: number; items: Item[] };
    expect(category.totalRevenueMinor).toBe(5500);
    expect(
      category.items.map((i) => [i.name, i.revenueMinor, i.unitsSold, i.sharePercent]),
    ).toEqual([
      ['Laptops', 3000, 3, 54.5],
      ['Smartphones', 2500, 5, 45.5],
    ]);

    const brand = (
      (await get('/sales-breakdown', { ...range, group: 'brand' }).expect(200)).body as {
        items: Item[];
      }
    ).items;
    expect(brand.map((i) => [i.name, i.revenueMinor])).toEqual([
      ['Dell', 3000],
      ['Apple', 2500],
    ]);
  });

  it('lists recent orders newest first with their customer', async () => {
    const items = (
      (await get('/recent-orders', { limit: 5 }).expect(200)).body as {
        items: { createdAt: string; itemCount: number; customer: { email: string } }[];
      }
    ).items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThanOrEqual(5);
    const times = items.map((i) => i.createdAt);
    expect(times).toEqual([...times].sort().reverse());
    expect(items[0].customer.email).toContain('@');
    expect(items[0].itemCount).toBeGreaterThanOrEqual(0);
  });

  // ── inventory widgets ──
  it('lists low-stock and out-of-stock variants, for operators too', async () => {
    const operator = await auth.createUser('INVENTORY_OPERATOR');
    const sku = `DSHI-${suffix}`;
    const product = await prisma.product.create({
      data: {
        name: `Dashboard Stock ${suffix}`,
        slug: `dsh-stock-${suffix.toLowerCase()}`, // keeps its ledger rows, so it is not removed by the fixture cleanup
        brandId: dellId,
        categoryId: laptopsId,
        specs: {},
        variants: {
          create: { sku, name: 'Stock variant', priceMinor: 1000, inventory: { create: {} } },
        },
      },
      select: { variants: { select: { id: true } } },
    });
    const variantId = product.variants[0].id;
    const find = async (path: string) =>
      (
        (await get(`/inventory/${path}`, { q: sku, limit: 50 }, operator).expect(200)).body as {
          items: Record<string, unknown>[];
        }
      ).items;

    expect(await find('low-stock')).toEqual([]); // never had stock: ignored, like the alert job

    await auth
      .api()
      .post(`/inventory/variants/${variantId}/stock-in`)
      .send({ quantity: 3 })
      .expect(201);
    expect(await find('low-stock')).toEqual([
      expect.objectContaining({ sku, onHand: 3, reserved: 0, available: 3, reorderLevel: 5 }),
    ]);
    expect(await find('out-of-stock')).toEqual([]);

    await auth
      .api()
      .post(`/inventory/variants/${variantId}/stock-out`)
      .send({ quantity: 3, reason: 'Dashboard test' })
      .expect(201);
    expect(await find('out-of-stock')).toEqual([expect.objectContaining({ sku, available: 0 })]);
    expect(await find('low-stock')).toHaveLength(1); // out of stock is also low

    await clearCache();
    const summary = (await get('/inventory/summary', {}, operator).expect(200)).body as Record<
      string,
      number
    >;
    expect(summary.lowStockCount).toBeGreaterThanOrEqual(1);
    expect(summary.outOfStockCount).toBeGreaterThanOrEqual(1);
    for (const key of [
      'totalStockValueMinor',
      'totalUnitsOnHand',
      'activeReservations',
      'reservedUnits',
    ]) {
      expect(Number.isInteger(summary[key])).toBe(true);
      expect(summary[key]).toBeGreaterThanOrEqual(0);
    }
  });

  it('lists recent ledger movements newest first', async () => {
    const items = (
      (await get('/inventory/movements', { limit: 5 }).expect(200)).body as {
        items: { sku: string; type: string; createdAt: string }[];
      }
    ).items;
    expect(items.length).toBeGreaterThan(0);
    const times = items.map((i) => i.createdAt);
    expect(times).toEqual([...times].sort().reverse());
    expect(items[0]).toEqual(
      expect.objectContaining({ sku: expect.any(String), type: expect.any(String) }),
    );
  });

  // ── exports ──
  it('exports sales and orders as CSV, without personal data, and audits it', async () => {
    const sales = await get('/export/sales.csv', { ...range, granularity: 'day' }).expect(200);
    expect(sales.headers['content-type']).toContain('text/csv');
    expect(sales.headers['content-disposition']).toContain('attachment');
    const salesLines = sales.text.trim().split('\r\n');
    expect(salesLines[0]).toBe('bucket,orders,revenueMinor,refundsMinor,unitsSold');
    expect(salesLines).toHaveLength(32);
    expect(salesLines).toContain('2001-03-06,1,1990,500,1');

    const orders = await get('/export/orders.csv', range).expect(200);
    const lines = orders.text.trim().split('\r\n');
    expect(lines[0]).toBe(
      'orderNumber,paidAt,status,subtotalMinor,shippingMinor,totalMinor,refundedMinor,units,currency',
    );
    expect(lines).toHaveLength(4); // header + the three paid orders
    expect(lines).toContain(
      `DSH-${suffix}-B,2001-03-06T12:00:00.000Z,PARTIALLY_REFUNDED,1000,990,1990,500,1,EUR`,
    );
    expect(orders.text).not.toContain('@'); // no emails

    expect(
      await prisma.auditLog.count({ where: { action: 'report.export', entityId: 'orders' } }),
    ).toBeGreaterThan(0);
  });

  // ── cache (keep last: it moves a fixture order and restores it) ──
  it('serves cached numbers until the TTL or a flush, and the source of truth is untouched', async () => {
    await clearCache();
    const orders = async () =>
      ((await get('/kpis', range).expect(200)).body as KpisBody).current.orders;
    expect(await orders()).toBe(3);

    await prisma.order.update({
      where: { id: orderC },
      data: { paidAt: new Date('2002-06-01T12:00:00Z') },
    });
    try {
      expect(await orders()).toBe(3); // still the cached copy
      await clearCache();
      expect(await orders()).toBe(2); // recomputed from the database
    } finally {
      await prisma.order.update({
        where: { id: orderC },
        data: { paidAt: new Date('2001-03-12T12:00:00Z') },
      });
      await clearCache();
    }
    expect(await orders()).toBe(3);
  });
});
