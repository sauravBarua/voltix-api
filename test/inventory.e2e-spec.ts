import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { TestAuth } from './helpers/auth';

type Ref = { id: string; slug: string };
type Stock = {
  variantId: string;
  onHand: number;
  reserved: number;
  available: number;
  reorderLevel: number;
};
type Mutation = {
  replayed: boolean;
  movement: { id: string; type: string; deltaOnHand: number; reason: string | null };
  stock: Stock;
};
type ListBody = { items: { variantId: string; lowStock: boolean }[]; meta: { total: number } };

describe('Inventory (e2e)', () => {
  let app: INestApplication<App>;
  let auth: TestAuth;
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
    auth = await TestAuth.create(app);
    prisma = app.get(PrismaService);

    const brands = (await http().get('/brands').expect(200)).body as Ref[];
    const categories = (await http().get('/categories').expect(200)).body as Ref[];
    brandId = brands.find((b) => b.slug === 'dell')!.id;
    categoryId = categories.find((c) => c.slug === 'laptops')!.id;
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => auth.api();

  /** A fresh variant with zero stock (created through the real catalog endpoints). */
  const createVariant = async () => {
    const n = ++counter;
    const product = (
      await http()
        .post('/products')
        .field(
          'data',
          JSON.stringify({ name: `Inventory Laptop ${suffix}-${n}`, brandId, categoryId, specs }),
        )
        .expect(201)
    ).body as { id: string };
    const sku = `INV-${suffix}-${n}`;
    const variant = (
      await http()
        .post(`/products/${product.id}/variants`)
        .field('data', JSON.stringify({ sku, name: 'Test variant', priceMinor: 1000 }))
        .expect(201)
    ).body as { id: string };
    return { id: variant.id, sku };
  };

  const op = (id: string, action: string, body: Record<string, unknown>) =>
    http().post(`/inventory/variants/${id}/${action}`).send(body);

  const stockOf = async (id: string) =>
    (await http().get(`/inventory/variants/${id}`).expect(200)).body as Stock;

  it('starts at zero, then stock-in increases on-hand and writes a ledger row', async () => {
    const v = await createVariant();
    expect(await stockOf(v.id)).toMatchObject({ onHand: 0, reserved: 0, available: 0 });

    const res = await op(v.id, 'stock-in', { quantity: 10, reason: 'Initial delivery' }).expect(
      201,
    );
    const body = res.body as Mutation;
    expect(body.replayed).toBe(false);
    expect(body.stock).toMatchObject({ onHand: 10, available: 10 });
    expect(body.movement).toMatchObject({ type: 'STOCK_IN', deltaOnHand: 10 });

    const ledger = (await http().get('/inventory/movements').query({ variantId: v.id }).expect(200))
      .body as {
      items: { type: string }[];
    };
    expect(ledger.items.map((m) => m.type)).toEqual(['STOCK_IN']);
  });

  it('validates input: reason, quantity, uuid, unknown variant', async () => {
    const v = await createVariant();
    await op(v.id, 'stock-out', { quantity: 1 }).expect(400); // reason required
    await op(v.id, 'stock-in', { quantity: 0 }).expect(400);
    await op(v.id, 'adjustments', { delta: 0, reason: 'nothing' }).expect(400);
    await http().get('/inventory/variants/not-a-uuid').expect(400);
    await op(randomUUID(), 'stock-in', { quantity: 1 }).expect(404);
    await http()
      .patch(`/inventory/variants/${v.id}/reorder-level`)
      .send({ reorderLevel: -1 })
      .expect(400);
  });

  it('never takes reserved units (stock-out and adjustment return 409)', async () => {
    const v = await createVariant();
    await op(v.id, 'stock-in', { quantity: 10 }).expect(201);
    // Simulate an active reservation (Phase 8 creates these for real)
    await prisma.$executeRaw`UPDATE inventory_items SET reserved = 3 WHERE variant_id = ${v.id}::uuid`;

    const tooMuch = await op(v.id, 'stock-out', { quantity: 8, reason: 'Too much' }).expect(409);
    expect(tooMuch.body).toMatchObject({ available: 7, onHand: 10, reserved: 3 });
    await op(v.id, 'adjustments', { delta: -8, reason: 'Below reserved' }).expect(409);

    await op(v.id, 'stock-out', { quantity: 7, reason: 'Exactly available' }).expect(201);
    expect(await stockOf(v.id)).toMatchObject({ onHand: 3, reserved: 3, available: 0 });

    // Undo the simulated reservation so test data stays consistent
    await prisma.$executeRaw`UPDATE inventory_items SET reserved = 0 WHERE variant_id = ${v.id}::uuid`;
  });

  it('adjusts up and down with a reason', async () => {
    const v = await createVariant();
    await op(v.id, 'stock-in', { quantity: 5 }).expect(201);
    await op(v.id, 'adjustments', { delta: -2, reason: 'Damaged in storage' }).expect(201);
    await op(v.id, 'adjustments', { delta: 4, reason: 'Stocktake correction' }).expect(201);
    expect(await stockOf(v.id)).toMatchObject({ onHand: 7 });
  });

  it('is idempotent: the same key applies once and replays with 200', async () => {
    const v = await createVariant();
    const key = `key-${randomUUID()}`;
    const first = await op(v.id, 'stock-in', { quantity: 5, idempotencyKey: key }).expect(201);
    const second = await op(v.id, 'stock-in', { quantity: 5, idempotencyKey: key }).expect(200);
    expect((second.body as Mutation).replayed).toBe(true);
    expect((second.body as Mutation).movement.id).toBe((first.body as Mutation).movement.id);
    expect(await stockOf(v.id)).toMatchObject({ onHand: 5 });
  });

  it('is idempotent under concurrent duplicates', async () => {
    const v = await createVariant();
    const key = `key-${randomUUID()}`;
    const statuses = await Promise.all(
      Array.from(
        { length: 5 },
        async () => (await op(v.id, 'stock-in', { quantity: 5, idempotencyKey: key })).status,
      ),
    );
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.every((s) => s === 201 || s === 200)).toBe(true);
    expect(await stockOf(v.id)).toMatchObject({ onHand: 5 });
  });

  it('does not oversell under concurrent stock-outs, and the ledger matches on-hand', async () => {
    const v = await createVariant();
    await op(v.id, 'stock-in', { quantity: 10 }).expect(201);

    const statuses = await Promise.all(
      Array.from(
        { length: 20 },
        async () => (await op(v.id, 'stock-out', { quantity: 1, reason: 'Race test' })).status,
      ),
    );
    expect(statuses.filter((s) => s === 201)).toHaveLength(10);
    expect(statuses.filter((s) => s === 409)).toHaveLength(10);
    expect(await stockOf(v.id)).toMatchObject({ onHand: 0, available: 0 });

    const sum = await prisma.inventoryMovement.aggregate({
      where: { variantId: v.id },
      _sum: { deltaOnHand: true },
    });
    expect(sum._sum.deltaOnHand).toBe(0); // +10 - 10
  });

  it('keeps the ledger append-only at the database level', async () => {
    const v = await createVariant();
    await op(v.id, 'stock-in', { quantity: 1 }).expect(201);
    await expect(
      prisma.$executeRaw`UPDATE inventory_movements SET reason = 'tampered' WHERE variant_id = ${v.id}::uuid`,
    ).rejects.toThrow();
    await expect(
      prisma.$executeRaw`DELETE FROM inventory_movements WHERE variant_id = ${v.id}::uuid`,
    ).rejects.toThrow();
  });

  it('lists low-stock and out-of-stock variants, and filters movements by type', async () => {
    const v = await createVariant();
    const query = { q: v.sku };

    const out = (
      await http()
        .get('/inventory')
        .query({ ...query, status: 'out' })
        .expect(200)
    ).body as ListBody;
    expect(out.items.map((i) => i.variantId)).toContain(v.id);

    await op(v.id, 'stock-in', { quantity: 3 }).expect(201); // reorder level defaults to 5
    const low = (
      await http()
        .get('/inventory')
        .query({ ...query, status: 'low' })
        .expect(200)
    ).body as ListBody;
    expect(low.items.find((i) => i.variantId === v.id)?.lowStock).toBe(true);

    await op(v.id, 'stock-in', { quantity: 100 }).expect(201);
    const after = (
      await http()
        .get('/inventory')
        .query({ ...query, status: 'low' })
        .expect(200)
    ).body as ListBody;
    expect(after.items.map((i) => i.variantId)).not.toContain(v.id);

    const ins = (
      await http()
        .get('/inventory/movements')
        .query({ variantId: v.id, type: 'STOCK_IN' })
        .expect(200)
    ).body as { items: { type: string }[] };
    expect(ins.items).toHaveLength(2);
    await http()
      .get('/inventory/movements')
      .query({ from: '2026-12-01T00:00:00Z', to: '2026-01-01T00:00:00Z' })
      .expect(400);
  });

  it('updates the reorder level', async () => {
    const v = await createVariant();
    const res = await http()
      .patch(`/inventory/variants/${v.id}/reorder-level`)
      .send({ reorderLevel: 12 })
      .expect(200);
    expect(res.body).toMatchObject({ reorderLevel: 12 });
    await http()
      .patch(`/inventory/variants/${randomUUID()}/reorder-level`)
      .send({ reorderLevel: 1 })
      .expect(404);
  });
});
