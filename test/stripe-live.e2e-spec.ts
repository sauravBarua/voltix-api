import 'dotenv/config';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import Stripe from 'stripe';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { TestAuth } from './helpers/auth';
import { Shop } from './helpers/shop';

jest.setTimeout(90_000);

// Runs only when asked: STRIPE_LIVE_TEST=1 and real TEST-mode keys in .env (never live keys, never the dummies)
const key = process.env.STRIPE_SECRET_KEY ?? '';
const whsec = process.env.STRIPE_WEBHOOK_SECRET ?? '';
const enabled =
  process.env.STRIPE_LIVE_TEST === '1' &&
  key.startsWith('sk_test_') &&
  !key.includes('dummy') &&
  whsec.startsWith('whsec_') &&
  !whsec.includes('dummy');

(enabled ? describe : describe.skip)('Stripe test mode, real API (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let auth: TestAuth;
  let shop: Shop;
  const stripe = new Stripe(key || 'sk_test_unused');

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile(); // real StripeService
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    auth = await TestAuth.create(app);
    shop = await Shop.create(auth);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('creates a real Checkout Session with the amounts and metadata from the database, then expires it on cancel', async () => {
    const user = await shop.customer();
    const variant = await shop.variant(5);
    const order = await shop.order(user, variant, 1); // 1000 + 990 shipping
    const p = await shop.pay(user, order.id);
    expect(p.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);

    const session = await stripe.checkout.sessions.retrieve(p.sessionId);
    expect(session).toMatchObject({
      status: 'open',
      currency: 'eur',
      amount_total: order.totalMinor,
      client_reference_id: order.id,
    });
    expect(session.metadata).toMatchObject({ orderId: order.id, paymentId: p.paymentId });
    expect(session.expires_at).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000) + 30 * 60); // Stripe's minimum

    await auth.api(user).post(`/orders/${order.id}/cancel`).expect(201); // expires the real session
    expect((await stripe.checkout.sessions.retrieve(p.sessionId)).status).toBe('expired');

    // the webhook Stripe would send, signed with the real secret
    const event = {
      id: `evt_live_${Date.now()}`,
      object: 'event',
      api_version: '2025-01-01',
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      type: 'checkout.session.expired',
      data: {
        object: { id: p.sessionId, object: 'checkout.session', status: 'expired', metadata: {} },
      },
    };
    const payload = JSON.stringify(event);
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: whsec });
    await request(app.getHttpServer())
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', signature)
      .send(payload)
      .expect(200);

    expect(await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } })).toMatchObject({
      status: 'EXPIRED',
    });
    expect(
      await prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true } }),
    ).toEqual({ status: 'CANCELLED' });
  });
});
