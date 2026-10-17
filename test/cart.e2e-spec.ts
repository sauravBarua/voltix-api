import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { API_PREFIX, configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

type Ref = { id: string; slug: string };
type Line = {
  variantId: string;
  quantity: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
  available: number;
  status: string;
};
type CartBody = {
  id: string | null;
  items: Line[];
  itemCount: number;
  subtotalMinor: number;
  hasIssues: boolean;
};

describe('Cart (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let brandId: string;
  let categoryId: string;
  let counter = 0;
  const suffix = Date.now().toString(36).toUpperCase();
  const specs = { cpu: 'Test CPU', screenSizeInch: 15.6, os: 'Windows 11' };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    const brands = (await api().get('/brands').expect(200)).body as Ref[];
    const categories = (await api().get('/categories').expect(200)).body as Ref[];
    brandId = brands.find((b) => b.slug === 'dell')!.id;
    categoryId = categories.find((c) => c.slug === 'laptops')!.id;
  });

  afterAll(async () => {
    await app.close();
  });

  /** Requests under /api/v1, optionally as a given user (temporary x-user-id header). */
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

  const createUser = async () => {
    const user = await prisma.user.create({
      data: { email: `cart-${suffix}-${++counter}@voltix.test`, name: 'Cart Test' },
      select: { id: true },
    });
    return user.id;
  };

  /** A fresh active variant priced at 1000, with `stock` units on hand. */
  const createVariant = async (stock: number) => {
    const n = ++counter;
    const product = (
      await api()
        .post('/products')
        .field(
          'data',
          JSON.stringify({ name: `Cart Laptop ${suffix}-${n}`, brandId, categoryId, specs }),
        )
        .expect(201)
    ).body as { id: string };
    const variant = (
      await api()
        .post(`/products/${product.id}/variants`)
        .field(
          'data',
          JSON.stringify({ sku: `CART-${suffix}-${n}`, name: 'Cart variant', priceMinor: 1000 }),
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

  const getCart = async (userId: string) =>
    (await api(userId).get('/cart').expect(200)).body as CartBody;
  const add = (userId: string, variantId: string, quantity: number) =>
    api(userId).post('/cart/items').send({ variantId, quantity });

  it('requires a valid x-user-id header (401)', async () => {
    await api().get('/cart').expect(401);
    await api('not-a-uuid').get('/cart').expect(401);
    await api(randomUUID()).get('/cart').expect(401);
  });

  it('returns an empty cart (without creating one) for a new user', async () => {
    const user = await createUser();
    const cart = await getCart(user);
    expect(cart).toMatchObject({
      id: null,
      items: [],
      itemCount: 0,
      subtotalMinor: 0,
      hasIssues: false,
    });
    expect(await prisma.cart.count({ where: { userId: user } })).toBe(0);
  });

  it('adds, increments, and refuses more than the available stock', async () => {
    const user = await createUser();
    const variant = await createVariant(5);

    const first = (await add(user, variant, 2).expect(200)).body as CartBody;
    expect(first.items).toHaveLength(1);
    expect(first).toMatchObject({ itemCount: 2, subtotalMinor: 2000, hasIssues: false });
    expect(first.items[0]).toMatchObject({
      unitPriceMinor: 1000,
      lineTotalMinor: 2000,
      available: 5,
      status: 'OK',
    });

    const second = (await add(user, variant, 2).expect(200)).body as CartBody;
    expect(second.items[0].quantity).toBe(4);

    const tooMany = await add(user, variant, 2).expect(409); // 4 + 2 > 5
    expect(tooMany.body).toMatchObject({ available: 5, requested: 6, inCart: 4 });
    expect((await getCart(user)).items[0].quantity).toBe(4);
  });

  it('does not reserve stock', async () => {
    const user = await createUser();
    const variant = await createVariant(5);
    await add(user, variant, 3).expect(200);
    const stock = (await api().get(`/inventory/variants/${variant}`).expect(200)).body as {
      onHand: number;
      reserved: number;
    };
    expect(stock).toMatchObject({ onHand: 5, reserved: 0 });
  });

  it('refuses out-of-stock, unknown and deactivated variants', async () => {
    const user = await createUser();
    const empty = await createVariant(0);
    const outOfStock = await add(user, empty, 1).expect(409);
    expect(outOfStock.body).toMatchObject({ message: 'This item is out of stock', available: 0 });

    await add(user, randomUUID(), 1).expect(404);

    const inactive = await createVariant(5);
    await api().delete(`/variants/${inactive}`).expect(204);
    await add(user, inactive, 1).expect(404);
  });

  it('enforces the per-line maximum (400)', async () => {
    const user = await createUser();
    const variant = await createVariant(50);
    await add(user, variant, 11).expect(400); // schema limit
    await add(user, variant, 10).expect(200);
    await add(user, variant, 1).expect(400); // 10 already in the cart
    await add(user, variant, 0).expect(400);
  });

  it('sets quantities: reduce freely, increase only within stock', async () => {
    const user = await createUser();
    const variant = await createVariant(5);
    await add(user, variant, 2).expect(200);

    const up = (await api(user).patch(`/cart/items/${variant}`).send({ quantity: 5 }).expect(200))
      .body as CartBody;
    expect(up.items[0].quantity).toBe(5);
    await api(user).patch(`/cart/items/${variant}`).send({ quantity: 6 }).expect(409);
    const down = (await api(user).patch(`/cart/items/${variant}`).send({ quantity: 1 }).expect(200))
      .body as CartBody;
    expect(down.items[0].quantity).toBe(1);

    await api(user).patch(`/cart/items/${variant}`).send({ quantity: 0 }).expect(400);
    await api(user).patch(`/cart/items/${randomUUID()}`).send({ quantity: 1 }).expect(404);
  });

  it('flags lines whose stock dropped or that were deactivated', async () => {
    const user = await createUser();
    const variant = await createVariant(5);
    await add(user, variant, 3).expect(200);

    await api()
      .post(`/inventory/variants/${variant}/stock-out`)
      .send({ quantity: 3, reason: 'Cart flag test' })
      .expect(201);
    let cart = await getCart(user);
    expect(cart.items[0]).toMatchObject({ status: 'INSUFFICIENT_STOCK', available: 2 });
    expect(cart.hasIssues).toBe(true);

    await api().delete(`/variants/${variant}`).expect(204);
    cart = await getCart(user);
    expect(cart.items[0].status).toBe('UNAVAILABLE');
    expect(cart.subtotalMinor).toBe(0);

    await api(user).patch(`/cart/items/${variant}`).send({ quantity: 1 }).expect(200); // reducing is allowed
    await api(user).patch(`/cart/items/${variant}`).send({ quantity: 5 }).expect(404); // increasing is not
    await api(user).delete(`/cart/items/${variant}`).expect(200);
  });

  it('removes lines and clears the cart', async () => {
    const user = await createUser();
    const a = await createVariant(5);
    const b = await createVariant(5);
    await add(user, a, 1).expect(200);
    await add(user, b, 2).expect(200);

    const removed = (await api(user).delete(`/cart/items/${a}`).expect(200)).body as CartBody;
    expect(removed.items.map((i) => i.variantId)).toEqual([b]);
    await api(user).delete(`/cart/items/${a}`).expect(404);

    const cleared = (await api(user).delete('/cart').expect(200)).body as CartBody;
    expect(cleared.items).toEqual([]);
    await api(user).delete('/cart').expect(200); // idempotent
  });

  it('keeps carts isolated per user', async () => {
    const alice = await createUser();
    const bob = await createUser();
    const variant = await createVariant(5);
    await add(alice, variant, 2).expect(200);
    expect((await getCart(bob)).items).toEqual([]);
    expect((await getCart(alice)).itemCount).toBe(2);
  });

  it('survives parallel adds (atomic increment, single cart)', async () => {
    const user = await createUser();
    const variant = await createVariant(10);
    const statuses = await Promise.all(
      Array.from({ length: 5 }, async () => (await add(user, variant, 1)).status),
    );
    expect(statuses.every((s) => s === 200)).toBe(true);

    const cart = await getCart(user);
    expect(cart.items).toHaveLength(1);
    expect(cart.items[0].quantity).toBe(5);
    expect(await prisma.cart.count({ where: { userId: user } })).toBe(1);
  });
});
