import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import Stripe from 'stripe';

export const WEBHOOK_SECRET = 'whsec_helper_test_secret';
const signer = new Stripe('sk_test_signing_only'); // only used for signing helpers: makes no API call

export const signPayload = (payload: string, opts: { secret?: string; timestamp?: number } = {}) =>
  signer.webhooks.generateTestHeaderString({
    payload,
    secret: opts.secret ?? WEBHOOK_SECRET,
    timestamp: opts.timestamp,
  });

/** A signed POST /webhooks/stripe. `signature: null` sends none. */
export function postWebhook(
  app: INestApplication,
  event: object,
  opts: { signature?: string | null } = {},
) {
  const payload = JSON.stringify(event);
  const req = request(app.getHttpServer())
    .post('/webhooks/stripe')
    .set('Content-Type', 'application/json');
  if (opts.signature !== null) req.set('Stripe-Signature', opts.signature ?? signPayload(payload));
  return req.send(payload);
}

// ── event builders ──
export const intentId = () => `pi_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
export const chargeOf = (intent: string) => `ch_${intent}`;

export const newEvent = (type: string, object: Record<string, unknown>) => ({
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

type Pay = { sessionId: string; paymentId: string };

export const completedEvent = (
  p: Pay,
  order: { id: string; totalMinor: number },
  intent: string,
  over: Record<string, unknown> = {},
) =>
  newEvent('checkout.session.completed', {
    id: p.sessionId,
    object: 'checkout.session',
    payment_status: 'paid',
    payment_intent: intent,
    amount_total: order.totalMinor,
    currency: 'eur',
    metadata: { orderId: order.id, paymentId: p.paymentId },
    ...over,
  });

export const expiredEvent = (p: Pay) =>
  newEvent('checkout.session.expired', {
    id: p.sessionId,
    object: 'checkout.session',
    status: 'expired',
    metadata: {},
  });

export const failedEvent = (p: Pay, orderId: string, intent: string) =>
  newEvent('payment_intent.payment_failed', {
    id: intent,
    metadata: { orderId, paymentId: p.paymentId },
    last_payment_error: { message: 'Your card was declined.' },
  });

export const refundedEvent = (intent: string, amount: number) =>
  newEvent('charge.refunded', {
    id: chargeOf(intent),
    object: 'charge',
    payment_intent: intent,
    amount_refunded: amount,
  });

// ── in-memory Stripe API ──
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

export class FakeStripe {
  sessions = new Map<string, FakeSession>();
  createCalls: { params: Stripe.Checkout.SessionCreateParams; idempotencyKey?: string }[] = [];
  expireCalls: string[] = [];
  refundCalls: { params: Stripe.RefundCreateParams; idempotencyKey?: string }[] = [];
  refundRecords: RefundRecord[] = [];
  /** Set to make the next session creations fail like a Stripe outage. */
  failCreate: Error | null = null;
  webhooks = signer.webhooks;
  private byKey = new Map<string, FakeSession>();

  checkout = {
    sessions: {
      create: (params: Stripe.Checkout.SessionCreateParams, opts?: { idempotencyKey?: string }) => {
        if (this.failCreate) return Promise.reject(this.failCreate);
        this.createCalls.push({ params, idempotencyKey: opts?.idempotencyKey });
        const known = opts?.idempotencyKey ? this.byKey.get(opts.idempotencyKey) : undefined;
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
        if (opts?.idempotencyKey) this.byKey.set(opts.idempotencyKey, session);
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

/** Value for `.overrideProvider(StripeService).useValue(...)`. The app needs `rawBody: true`. */
export const stripeServiceValue = (fake: FakeStripe) => ({
  client: fake as unknown as Stripe,
  webhookSecret: WEBHOOK_SECRET,
  frontendUrl: 'http://localhost:3001',
});
