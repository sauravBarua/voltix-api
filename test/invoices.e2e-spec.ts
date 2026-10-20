import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { StripeService } from '../src/payments/stripe.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { TestAuth } from './helpers/auth';
import { Shop } from './helpers/shop';
import {
  FakeStripe,
  completedEvent,
  intentId,
  postWebhook,
  stripeServiceValue,
} from './helpers/stripe-fake';

jest.setTimeout(60_000);

const binary = (res: any, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('Invoices (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let auth: TestAuth;
  let shop: Shop;
  const fake = new FakeStripe();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(StripeService)
      .useValue(stripeServiceValue(fake))
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    auth = await TestAuth.create(app);
    shop = await Shop.create(auth);
  });

  afterAll(async () => {
    await app.close();
  });

  const paidOrder = async () => {
    const user = await shop.customer();
    const order = await shop.order(user, await shop.variant(5), 2);
    const p = await shop.pay(user, order.id);
    await postWebhook(app, completedEvent(p, order, intentId())).expect(200);
    return { user, order };
  };
  const download = (who: string | undefined, orderId: string, admin = false) =>
    auth
      .api(who)
      .get(admin ? `/admin/orders/${orderId}/invoice` : `/orders/${orderId}/invoice`)
      .buffer(true)
      .parse(binary);

  it('serves a PDF to the owner and an administrator, with a stable number', async () => {
    const { user, order } = await paidOrder();
    const first = await download(user, order.id).expect(200);
    expect(first.headers['content-type']).toContain('application/pdf');
    expect((first.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');

    const number = (await prisma.invoice.findUniqueOrThrow({ where: { orderId: order.id } }))
      .number;
    expect(number).toMatch(/^INV-\d{4}-\d{6}$/);
    expect(first.headers['content-disposition']).toContain(number);

    await download(user, order.id).expect(200); // again: same invoice, no new number
    await download(undefined, order.id, true).expect(200);
    expect(await prisma.invoice.count({ where: { orderId: order.id } })).toBe(1);
  });

  it('gives different orders consecutive, distinct numbers, even in parallel', async () => {
    const a = await paidOrder();
    const b = await paidOrder();
    await Promise.all([
      download(a.user, a.order.id).expect(200),
      download(b.user, b.order.id).expect(200),
    ]);
    const rows = await prisma.invoice.findMany({
      where: { orderId: { in: [a.order.id, b.order.id] } },
      select: { number: true },
    });
    expect(new Set(rows.map((r) => r.number)).size).toBe(2);
  });

  it('refuses other users, unpaid orders and customers on the admin route', async () => {
    const { order } = await paidOrder();
    const stranger = await shop.customer();
    await download(stranger, order.id).expect(404);
    await download(stranger, order.id, true).expect(403);
    await download('anon', order.id).expect(401);

    const user = await shop.customer();
    const unpaid = await shop.order(user, await shop.variant(3), 1);
    await download(user, unpaid.id).expect(404);
    expect(await prisma.invoice.count({ where: { orderId: unpaid.id } })).toBe(0);
  });
});
