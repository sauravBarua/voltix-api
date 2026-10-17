import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, type TestingModule } from '@nestjs/testing';
import { type Socket, io } from 'socket.io-client';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import type { Env } from '../src/config/env';
import { RabbitMqService } from '../src/messaging/rabbitmq.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { WorkerModule } from '../src/worker.module';
import { TestAuth } from './helpers/auth';

jest.setTimeout(60_000);

type Evt = { name: string; data: Record<string, unknown> };
type Client = { socket: Socket; events: Evt[] };
type Ref = { id: string; slug: string };
type StockItem = {
  variantId: string;
  sku: string;
  onHand: number;
  reserved: number;
  available: number;
  lowStock: boolean;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor<T>(check: () => T | undefined, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for the condition');
    await sleep(100);
  }
}

const address = {
  fullName: 'Realtime Test',
  line1: '1 Rue de Test',
  city: 'Paris',
  postalCode: '75001',
  country: 'FR',
};

describe('Realtime (e2e)', () => {
  let app: INestApplication<App>;
  let worker: TestingModule;
  let prisma: PrismaService;
  let auth: TestAuth;
  let secret: string;
  let url: string;
  let brandId: string;
  let categoryId: string;
  let counter = 0;
  const sockets: Socket[] = [];
  const suffix = Date.now().toString(36).toUpperCase();
  const specs = { cpu: 'Test CPU', screenSizeInch: 15.6, os: 'Windows 11' };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    await app.listen(0); // Socket.IO needs a real port
    url = `http://127.0.0.1:${((app.getHttpServer() as unknown as Server).address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);
    auth = await TestAuth.create(app);
    secret = app
      .get<ConfigService<Env, true>>(ConfigService)
      .get('JWT_ACCESS_SECRET', { infer: true });

    worker = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    await worker.init();
    await worker.get(RabbitMqService).waitUntilReady(15_000);

    const brands = (await auth.api().get('/brands').expect(200)).body as Ref[];
    const categories = (await auth.api().get('/categories').expect(200)).body as Ref[];
    brandId = brands.find((b) => b.slug === 'dell')!.id;
    categoryId = categories.find((c) => c.slug === 'laptops')!.id;
  });

  afterAll(async () => {
    for (const socket of sockets) socket.close();
    await worker?.close();
    await app?.close();
  });

  // ── helpers ──
  const tokenOf = (userId: string) => auth.header(userId).Authorization.replace('Bearer ', '');

  /** Listeners are attached before the connection completes, so no event is missed. */
  const connect = (token?: string): Client => {
    const socket = io(`${url}/realtime`, {
      auth: token ? { token } : {},
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    sockets.push(socket);
    const events: Evt[] = [];
    socket.onAny((name: string, data: Record<string, unknown>) => events.push({ name, data }));
    return { socket, events };
  };
  const rejected = (c: Client) =>
    new Promise<string>((resolve) =>
      c.socket.once('connect_error', (e: Error) => resolve(e.message)),
    );
  const eventOf = (
    c: Client,
    name: string,
    match: (data: Record<string, unknown>) => boolean = () => true,
  ) => waitFor(() => c.events.find((e) => e.name === name && match(e.data)));
  const connected = async (userId: string) => {
    const client = connect(tokenOf(userId));
    await eventOf(client, 'ready');
    return client;
  };
  const none = (c: Client, name: string) => c.events.filter((e) => e.name === name);

  const createVariant = async (stock: number) => {
    const n = ++counter;
    const product = (
      await auth
        .api()
        .post('/products')
        .field(
          'data',
          JSON.stringify({ name: `Realtime Laptop ${suffix}-${n}`, brandId, categoryId, specs }),
        )
        .expect(201)
    ).body as { id: string };
    const variant = (
      await auth
        .api()
        .post(`/products/${product.id}/variants`)
        .field(
          'data',
          JSON.stringify({ sku: `RT-${suffix}-${n}`, name: 'Realtime variant', priceMinor: 1000 }),
        )
        .expect(201)
    ).body as { id: string };
    if (stock > 0)
      await auth
        .api()
        .post(`/inventory/variants/${variant.id}/stock-in`)
        .send({ quantity: stock })
        .expect(201);
    return variant.id;
  };
  const checkout = async (userId: string, variantId: string) => {
    await auth.api(userId).post('/cart/items').send({ variantId, quantity: 1 }).expect(200);
    const res = await auth
      .api(userId)
      .post('/orders/checkout')
      .set('Idempotency-Key', randomUUID())
      .send({ shippingAddress: address })
      .expect(201);
    return (res.body as { order: { id: string } }).order.id;
  };

  // ── tests ──
  it('rejects missing, forged and deactivated credentials', async () => {
    expect(await rejected(connect())).toBe('unauthorized');
    expect(await rejected(connect('not-a-jwt'))).toBe('unauthorized');

    const user = await auth.createUser('CUSTOMER');
    const token = tokenOf(user);
    await prisma.user.update({ where: { id: user }, data: { isActive: false } });
    expect(await rejected(connect(token))).toBe('unauthorized');
  });

  it('puts every role in exactly the rooms it may see', async () => {
    const [customer, operator, admin] = [
      await auth.createUser('CUSTOMER'),
      await auth.createUser('INVENTORY_OPERATOR'),
      await auth.createUser('ADMIN'),
    ];
    const rooms = async (id: string) =>
      ((await eventOf(await connected(id), 'ready')).data.rooms as string[]).sort();

    expect(await rooms(customer)).toEqual([`user:${customer}`]);
    expect(await rooms(operator)).toEqual(['inventory', `user:${operator}`].sort());
    expect(await rooms(admin)).toEqual(['inventory', 'orders', `user:${admin}`].sort());
  });

  it('delivers inventory changes to staff only, with live availability', async () => {
    const [customer, operator, admin] = await Promise.all([
      connected(await auth.createUser('CUSTOMER')),
      connected(await auth.createUser('INVENTORY_OPERATOR')),
      connected(await auth.createUser('ADMIN')),
    ]);
    const variant = await createVariant(0);

    await auth
      .api()
      .post(`/inventory/variants/${variant}/stock-in`)
      .send({ quantity: 6 })
      .expect(201);
    const mine = (d: Record<string, unknown>) =>
      (d.items as StockItem[]).some((i) => i.variantId === variant);

    const fromAdmin = await eventOf(admin, 'inventory:changed', mine);
    expect(
      (fromAdmin.data.items as StockItem[]).find((i) => i.variantId === variant),
    ).toMatchObject({
      onHand: 6,
      reserved: 0,
      available: 6,
      lowStock: false,
    });
    await eventOf(operator, 'inventory:changed', mine);
    await sleep(500);
    expect(none(customer, 'inventory:changed')).toEqual([]);
  });

  it('announces new orders to admins only, and status changes to admins and the owner only', async () => {
    const owner = await auth.createUser('CUSTOMER');
    const [ownerClient, stranger, operator, admin] = await Promise.all([
      connected(owner),
      connected(await auth.createUser('CUSTOMER')),
      connected(await auth.createUser('INVENTORY_OPERATOR')),
      connected(await auth.createUser('ADMIN')),
    ]);
    const orderId = await checkout(owner, await createVariant(5));
    const forOrder = (d: Record<string, unknown>) => d.orderId === orderId;

    const created = await eventOf(admin, 'order:created', forOrder);
    expect(created.data).toMatchObject({
      status: 'PENDING_PAYMENT',
      totalMinor: 1990,
      currency: 'EUR',
    });
    expect(JSON.stringify(created.data)).not.toMatch(/Rue de Test|email/i);

    await auth.api(owner).post(`/orders/${orderId}/cancel`).expect(201);
    const adminUpdate = await eventOf(admin, 'order:updated', forOrder);
    const ownerUpdate = await eventOf(ownerClient, 'order:updated', forOrder);
    expect(adminUpdate.data).toMatchObject({ status: 'CANCELLED', type: 'order.cancelled' });
    expect(ownerUpdate.data.orderId).toBe(orderId);

    await sleep(500);
    for (const client of [stranger, operator]) {
      expect(none(client, 'order:created')).toEqual([]);
      expect(none(client, 'order:updated').filter((e) => forOrder(e.data))).toEqual([]);
    }
    expect(none(ownerClient, 'order:created')).toEqual([]);
  });

  it('notifies staff and the owner when a reservation expires', async () => {
    const owner = await auth.createUser('CUSTOMER');
    const [ownerClient, operator, admin] = await Promise.all([
      connected(owner),
      connected(await auth.createUser('INVENTORY_OPERATOR')),
      connected(await auth.createUser('ADMIN')),
    ]);
    const orderId = await checkout(owner, await createVariant(5));
    const forOrder = (d: Record<string, unknown>) => d.orderId === orderId;

    await prisma.$executeRaw`UPDATE stock_reservations SET expires_at = now() - interval '1 minute' WHERE order_id = ${orderId}::uuid`;
    await auth.api().post('/reservations/expire-due').expect(200);

    await eventOf(admin, 'reservation:expired', forOrder);
    await eventOf(operator, 'reservation:expired', forOrder);
    expect((await eventOf(ownerClient, 'order:updated', forOrder)).data.status).toBe('CANCELLED');
  });

  it('ends the session when the access token expires', async () => {
    const user = await auth.createUser('CUSTOMER');
    const short = new JwtService({ secret }).sign(
      { sub: user },
      { issuer: 'voltix-api', expiresIn: 3 },
    );
    const client = connect(short);
    await eventOf(client, 'ready');

    await eventOf(client, 'auth:expired');
    await waitFor(() => (client.socket.connected ? undefined : true));
  });
});
