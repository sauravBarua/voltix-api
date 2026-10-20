import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import type Stripe from 'stripe';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { JobScheduler } from '../src/jobs/job-scheduler';
import { JOB_NAMES } from '../src/jobs/jobs.constants';
import { LowStockAlertsJob } from '../src/jobs/low-stock-alerts.job';
import { StockReconciliationJob } from '../src/jobs/stock-reconciliation.job';
import { StripeService } from '../src/payments/stripe.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { ReservationsService } from '../src/reservations/reservations.service';
import { WorkerModule } from '../src/worker.module';
import { TestAuth } from './helpers/auth';

jest.setTimeout(60_000);

const missing = (what: string) =>
  Object.assign(new Error(`No such ${what}`), { code: 'resource_missing' });

class FakeStripe {
  sessions = new Map<string, Record<string, unknown>>();
  intents = new Map<string, Record<string, unknown>>();
  refundCalls: { params: Stripe.RefundCreateParams; idempotencyKey?: string }[] = [];

  checkout = {
    sessions: {
      retrieve: (id: string) => {
        const session = this.sessions.get(id);
        return session ? Promise.resolve(session) : Promise.reject(missing('session'));
      },
      expire: () => Promise.resolve({}),
    },
  };
  paymentIntents = {
    retrieve: (id: string) => {
      const intent = this.intents.get(id);
      return intent ? Promise.resolve(intent) : Promise.reject(missing('payment intent'));
    },
  };
  refunds = {
    create: (params: Stripe.RefundCreateParams, opts?: { idempotencyKey?: string }) => {
      this.refundCalls.push({ params, idempotencyKey: opts?.idempotencyKey });
      return Promise.resolve({ id: `re_${randomUUID().replaceAll('-', '')}`, status: 'succeeded' });
    },
    list: () => Promise.resolve({ data: [] }),
  };
}

type Ref = { id: string; slug: string };
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

describe('Background jobs (e2e)', () => {
  let app: INestApplication<App>;
  let worker: TestingModule;
  let prisma: PrismaService;
  let auth: TestAuth;
  let scheduler: JobScheduler;
  let reservations: ReservationsService;
  let brandId: string;
  let categoryId: string;
  let counter = 0;
  const fake = new FakeStripe();
  const orders: string[] = [];
  const suffix = Date.now().toString(36).toUpperCase();
  const specs = { cpu: 'Test CPU', screenSizeInch: 15.6, os: 'Windows 11' };

  beforeAll(async () => {
    const appModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = appModule.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    auth = await TestAuth.create(app);

    worker = await Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(StripeService)
      .useValue({
        client: fake as unknown as Stripe,
        webhookSecret: 'whsec_e2e',
        frontendUrl: 'http://localhost:3001',
      })
      .compile();
    await worker.init();
    scheduler = worker.get(JobScheduler);
    reservations = worker.get(ReservationsService);

    const brands = (await auth.api().get('/brands').expect(200)).body as Ref[];
    const categories = (await auth.api().get('/categories').expect(200)).body as Ref[];
    brandId = brands.find((b) => b.slug === 'dell')!.id;
    categoryId = categories.find((c) => c.slug === 'laptops')!.id;
  });

  afterAll(async () => {
    for (const id of orders) {
      await prisma.$transaction(async (tx) => {
        await reservations.release(tx, id);
        await tx.order.updateMany({
          where: { id, status: 'PENDING_PAYMENT' },
          data: { status: 'CANCELLED', cancelReason: 'TEST_CLEANUP', cancelledAt: new Date() },
        });
      });
    }
    await prisma.outboxEvent.deleteMany({ where: { aggregateType: 'e2e-jobs' } });
    await prisma.processedMessage.deleteMany({ where: { consumer: 'e2e-jobs' } });
    await prisma.jobLock.deleteMany({ where: { name: 'e2e-slow' } });
    await worker?.close();
    await app?.close();
  });

  // ── helpers ──
  const createVariant = async (stock: number) => {
    const n = ++counter;
    const product = (
      await auth
        .api()
        .post('/products')
        .field(
          'data',
          JSON.stringify({ name: `Jobs Laptop ${suffix}-${n}`, brandId, categoryId, specs }),
        )
        .expect(201)
    ).body as { id: string };
    const variant = (
      await auth
        .api()
        .post(`/products/${product.id}/variants`)
        .field(
          'data',
          JSON.stringify({ sku: `JOB-${suffix}-${n}`, name: 'Jobs variant', priceMinor: 1000 }),
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

  /** A pending order (2 units reserved) for a fresh user, optionally with an old Stripe payment attached. */
  const makeOrder = async (opts: { sessionId?: string } = {}) => {
    const n = ++counter;
    const user = await prisma.user.create({
      data: { email: `jobs-${suffix}-${n}@voltix.test`, name: 'Jobs Test' },
      select: { id: true },
    });
    const variant = await createVariant(5);
    const order = await prisma.order.create({
      data: {
        orderNumber: `JOB-${suffix}-${n}`,
        userId: user.id,
        subtotalMinor: 2000,
        totalMinor: 2000,
        idempotencyKey: randomUUID(),
        shippingAddress: {},
        items: {
          create: [
            {
              variantId: variant,
              skuSnapshot: 'x',
              nameSnapshot: 'x',
              unitPriceMinor: 1000,
              quantity: 2,
            },
          ],
        },
      },
      select: { id: true },
    });
    orders.push(order.id);
    await prisma.$transaction((tx) =>
      reservations.reserve(tx, { orderId: order.id, lines: [{ variantId: variant, quantity: 2 }] }),
    );
    if (opts.sessionId) {
      await prisma.payment.create({
        data: {
          orderId: order.id,
          stripeSessionId: opts.sessionId,
          amountMinor: 2000,
          idempotencyKey: `job-test:${randomUUID()}`,
          createdAt: minutesAgo(40),
        },
      });
    }
    return { orderId: order.id, variant };
  };

  /** A cancelled order whose late payment still has to be refunded. */
  const makeLatePayment = async (intentId: string, amountRefunded: number) => {
    const n = ++counter;
    const user = await prisma.user.create({
      data: { email: `jobs-late-${suffix}-${n}@voltix.test`, name: 'Jobs Late' },
      select: { id: true },
    });
    const order = await prisma.order.create({
      data: {
        orderNumber: `JOBL-${suffix}-${n}`,
        userId: user.id,
        status: 'CANCELLED',
        cancelReason: 'PAID_AFTER_EXPIRY',
        subtotalMinor: 2000,
        totalMinor: 2000,
        idempotencyKey: randomUUID(),
        shippingAddress: {},
      },
      select: { id: true },
    });
    const payment = await prisma.payment.create({
      data: {
        orderId: order.id,
        status: 'PAID',
        failureReason: 'PAID_AFTER_EXPIRY_NO_STOCK',
        stripeSessionId: `cs_test_late_${randomUUID().replaceAll('-', '')}`,
        stripePaymentIntentId: intentId,
        amountMinor: 2000,
        idempotencyKey: `job-test:${randomUUID()}`,
      },
      select: { id: true },
    });
    await prisma.$executeRaw`UPDATE payments SET updated_at = now() - interval '10 minutes' WHERE id = ${payment.id}::uuid`;
    fake.intents.set(intentId, {
      id: intentId,
      latest_charge: {
        id: `ch_${intentId}`,
        object: 'charge',
        amount: 2000,
        amount_refunded: amountRefunded,
        payment_intent: intentId,
      },
    });
    return payment.id;
  };

  const stockRow = (variantId: string) =>
    prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId },
      select: { onHand: true, reserved: true },
    });
  const orderRow = (id: string) =>
    prisma.order.findUniqueOrThrow({ where: { id }, select: { status: true, cancelReason: true } });
  const paymentRow = (orderId: string) => prisma.payment.findFirstOrThrow({ where: { orderId } });

  // ── scheduler ──
  it('lets only one worker run a job at a time, and records every run', async () => {
    let started = 0;
    scheduler.register({
      name: 'e2e-slow',
      intervalMs: 60_000,
      leaseSeconds: 30,
      run: async () => {
        started++;
        await new Promise((resolve) => setTimeout(resolve, 400));
        return { ok: true };
      },
    });

    const outcomes = await Promise.all([
      scheduler.runNow('e2e-slow'),
      scheduler.runNow('e2e-slow'),
    ]);
    expect(outcomes.map((o) => o.status).sort()).toEqual(['ok', 'skipped']);
    expect(started).toBe(1);

    const runs = await prisma.jobRun.findMany({ where: { job: 'e2e-slow' } });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'OK', result: { ok: true } });
    expect(runs[0].finishedAt).not.toBeNull();

    // the lease was released: the next run goes through
    expect((await scheduler.runNow('e2e-slow')).status).toBe('ok');
  });

  it('skips a job while an unexpired lease exists, and takes over after it expires', async () => {
    await prisma.$executeRaw`
      INSERT INTO job_locks (name, locked_until, locked_by) VALUES ('e2e-slow', now() + interval '1 hour', 'another-worker')
      ON CONFLICT (name) DO UPDATE SET locked_until = EXCLUDED.locked_until, locked_by = EXCLUDED.locked_by`;
    expect((await scheduler.runNow('e2e-slow')).status).toBe('skipped');

    await prisma.$executeRaw`UPDATE job_locks SET locked_until = now() - interval '1 second' WHERE name = 'e2e-slow'`;
    expect((await scheduler.runNow('e2e-slow')).status).toBe('ok');
  });

  it('records a failing job as FAILED without blocking the next run', async () => {
    scheduler.register({
      name: 'e2e-failing',
      intervalMs: 60_000,
      leaseSeconds: 30,
      run: () => Promise.reject(new Error('boom')),
    });
    expect(await scheduler.runNow('e2e-failing')).toEqual({ status: 'failed', error: 'boom' });
    const run = await prisma.jobRun.findFirstOrThrow({ where: { job: 'e2e-failing' } });
    expect(run).toMatchObject({ status: 'FAILED', error: 'boom' });
    expect((await scheduler.runNow('e2e-failing')).status).toBe('failed'); // the lease was released
    await prisma.jobRun.deleteMany({ where: { job: 'e2e-failing' } });
    await prisma.jobLock.deleteMany({ where: { name: 'e2e-failing' } });
  });

  // ── reservation expiry ──
  it('expires due reservations and cancels their orders', async () => {
    const { orderId, variant } = await makeOrder();
    expect(await stockRow(variant)).toEqual({ onHand: 5, reserved: 2 });
    await prisma.$executeRaw`UPDATE stock_reservations SET expires_at = now() - interval '1 minute' WHERE order_id = ${orderId}::uuid`;

    const outcome = await scheduler.runNow('reservation-expiry');
    expect(outcome.status).toBe('ok');
    expect(await orderRow(orderId)).toEqual({
      status: 'CANCELLED',
      cancelReason: 'RESERVATION_EXPIRED',
    });
    expect(await stockRow(variant)).toEqual({ onHand: 5, reserved: 0 });
  });

  // ── low stock ──
  it('alerts once per drop and re-arms on recovery', async () => {
    const job = worker.get(LowStockAlertsJob);
    const variant = await createVariant(3); // reorder level defaults to 5
    const events = () =>
      prisma.outboxEvent.count({ where: { aggregateId: variant, type: 'inventory.low_stock' } });
    const armed = () => prisma.lowStockAlert.count({ where: { variantId: variant } });

    await job.run(100_000); // uncapped here: other low variants in the dev database must not crowd this one out
    expect(await events()).toBe(1);
    expect(await armed()).toBe(1);
    const event = await prisma.outboxEvent.findFirstOrThrow({
      where: { aggregateId: variant, type: 'inventory.low_stock' },
    });
    expect(event.payload).toMatchObject({
      variantId: variant,
      available: 3,
      reorderLevel: 5,
      outOfStock: false,
    });

    await job.run(100_000);
    expect(await events()).toBe(1); // no repeat while it stays low

    await auth
      .api()
      .post(`/inventory/variants/${variant}/stock-in`)
      .send({ quantity: 20 })
      .expect(201);
    const recovered = await job.run(100_000);
    expect(recovered.rearmed).toBeGreaterThanOrEqual(1);
    expect(await armed()).toBe(0);

    await auth
      .api()
      .post(`/inventory/variants/${variant}/stock-out`)
      .send({ quantity: 21, reason: 'Low stock job test' })
      .expect(201);
    await job.run(100_000);
    expect(await events()).toBe(2); // dropped again: a new alert
  });

  it('never alerts for a variant that never had stock', async () => {
    const job = worker.get(LowStockAlertsJob);
    const variant = await createVariant(0);
    await job.run(100_000);
    expect(
      await prisma.outboxEvent.count({
        where: { aggregateId: variant, type: 'inventory.low_stock' },
      }),
    ).toBe(0);
  });

  // ── stock reconciliation ──
  it('detects stock that disagrees with the ledger or the reservations, and alerts once', async () => {
    const job = worker.get(StockReconciliationJob);
    const variant = await createVariant(5);
    const alerts = () =>
      prisma.outboxEvent.count({ where: { type: 'inventory.reconciliation_mismatch' } });
    const found = async () => (await job.findMismatches()).find((m) => m.variantId === variant);

    expect(await found()).toBeUndefined();

    await prisma.$executeRaw`UPDATE inventory_items SET on_hand = on_hand + 1 WHERE variant_id = ${variant}::uuid`;
    expect(await found()).toMatchObject({ onHand: 6, ledgerOnHand: 5 });

    const before = await alerts();
    const first = await scheduler.runNow('stock-reconciliation');
    expect(first.status).toBe('ok');
    expect(await alerts()).toBe(before + 1);
    await scheduler.runNow('stock-reconciliation');
    expect(await alerts()).toBe(before + 1); // same mismatch: no second alert

    await prisma.$executeRaw`UPDATE inventory_items SET on_hand = 5 WHERE variant_id = ${variant}::uuid`;
    expect(await found()).toBeUndefined();

    await prisma.$executeRaw`UPDATE inventory_items SET reserved = 1 WHERE variant_id = ${variant}::uuid`;
    expect(await found()).toMatchObject({ reserved: 1, activeReserved: 0, ledgerReserved: 0 });
    await prisma.$executeRaw`UPDATE inventory_items SET reserved = 0 WHERE variant_id = ${variant}::uuid`;
    expect(await found()).toBeUndefined();
  });

  // ── payment reconciliation ──
  it('settles payments the webhook missed, using what Stripe says', async () => {
    const paidSession = `cs_test_paid_${randomUUID().replaceAll('-', '')}`;
    const expiredSession = `cs_test_expired_${randomUUID().replaceAll('-', '')}`;
    const openSession = `cs_test_open_${randomUUID().replaceAll('-', '')}`;
    const unknownSession = `cs_test_unknown_${randomUUID().replaceAll('-', '')}`;

    const paid = await makeOrder({ sessionId: paidSession });
    const expired = await makeOrder({ sessionId: expiredSession });
    const open = await makeOrder({ sessionId: openSession });
    const unknown = await makeOrder({ sessionId: unknownSession });
    fake.sessions.set(paidSession, {
      id: paidSession,
      status: 'complete',
      payment_status: 'paid',
      payment_intent: `pi_${randomUUID().slice(0, 12)}`,
      amount_total: 2000,
      currency: 'eur',
    });
    fake.sessions.set(expiredSession, {
      id: expiredSession,
      status: 'expired',
      payment_status: 'unpaid',
      payment_intent: null,
      amount_total: 2000,
      currency: 'eur',
    });
    fake.sessions.set(openSession, {
      id: openSession,
      status: 'open',
      payment_status: 'unpaid',
      payment_intent: null,
      amount_total: 2000,
      currency: 'eur',
    });

    const outcome = await scheduler.runNow('payment-reconciliation');
    expect(outcome.status).toBe('ok');

    expect(await orderRow(paid.orderId)).toMatchObject({ status: 'PAID' });
    expect(await paymentRow(paid.orderId)).toMatchObject({ status: 'PAID' });
    expect(await stockRow(paid.variant)).toEqual({ onHand: 3, reserved: 0 });

    expect(await orderRow(expired.orderId)).toEqual({
      status: 'CANCELLED',
      cancelReason: 'PAYMENT_EXPIRED',
    });
    expect(await paymentRow(expired.orderId)).toMatchObject({ status: 'EXPIRED' });
    expect(await stockRow(expired.variant)).toEqual({ onHand: 5, reserved: 0 });

    expect((await orderRow(open.orderId)).status).toBe('PENDING_PAYMENT'); // still payable: left alone
    expect(await paymentRow(open.orderId)).toMatchObject({ status: 'PENDING' });

    expect(await paymentRow(unknown.orderId)).toMatchObject({
      status: 'EXPIRED',
      failureReason: 'SESSION_NOT_FOUND',
    });

    // running again changes nothing
    await scheduler.runNow('payment-reconciliation');
    expect(await stockRow(paid.variant)).toEqual({ onHand: 3, reserved: 0 });
    expect(await orderRow(paid.orderId)).toMatchObject({ status: 'PAID' });
  });

  it('retries unfinished auto-refunds, and records refunds Stripe already made', async () => {
    const needsRefund = await makeLatePayment(`pi_e2e_a_${randomUUID().slice(0, 10)}`, 0);
    const alreadyRefunded = await makeLatePayment(`pi_e2e_b_${randomUUID().slice(0, 10)}`, 2000);

    await scheduler.runNow('payment-reconciliation');

    const retried = fake.refundCalls.filter(
      (c) => c.idempotencyKey === `auto-refund:${needsRefund}`,
    );
    expect(retried).toHaveLength(1);
    expect(retried[0].params).toMatchObject({ amount: 2000 });
    expect(
      fake.refundCalls.some((c) => c.idempotencyKey === `auto-refund:${alreadyRefunded}`),
    ).toBe(false);

    const synced = await prisma.payment.findUniqueOrThrow({ where: { id: alreadyRefunded } });
    expect(synced).toMatchObject({ status: 'REFUNDED', refundedMinor: 2000 });
  });

  // ── cleanup ──
  it('purges old operational rows and keeps recent, pending and failed ones', async () => {
    const user = await auth.createUser('CUSTOMER');
    const tag = randomUUID();
    const outbox = (
      status: 'PUBLISHED' | 'PENDING' | 'FAILED',
      publishedAt: Date | null,
      createdAt: Date,
    ) =>
      prisma.outboxEvent.create({
        data: {
          aggregateType: 'e2e-jobs',
          aggregateId: randomUUID(),
          type: 'e2e.cleanup',
          payload: {},
          status,
          publishedAt,
          createdAt,
        },
        select: { id: true },
      });
    const oldPublished = await outbox('PUBLISHED', daysAgo(10), daysAgo(10));
    const recentPublished = await outbox('PUBLISHED', new Date(), new Date());
    const oldPending = await outbox('PENDING', null, daysAgo(10));
    const oldFailed = await outbox('FAILED', null, daysAgo(10));

    await prisma.processedMessage.createMany({
      data: [
        { consumer: 'e2e-jobs', messageId: `old-${tag}`, processedAt: daysAgo(20) },
        { consumer: 'e2e-jobs', messageId: `new-${tag}` },
      ],
    });
    await prisma.stripeWebhookEvent.create({
      data: { stripeEventId: `evt_e2e_old_${tag}`, type: 'x', receivedAt: daysAgo(40) },
    });
    await prisma.refreshToken.createMany({
      data: [
        {
          userId: user,
          familyId: randomUUID(),
          tokenHash: `e2e-expired-${tag}`,
          expiresAt: daysAgo(20),
        },
        {
          userId: user,
          familyId: randomUUID(),
          tokenHash: `e2e-valid-${tag}`,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
        {
          userId: user,
          familyId: randomUUID(),
          tokenHash: `e2e-revoked-live-${tag}`,
          expiresAt: new Date(Date.now() + 86_400_000),
          revokedAt: daysAgo(30),
        },
      ],
    });
    await prisma.auditLog.createMany({
      data: [
        { action: `e2e.jobs.old.${tag}`, createdAt: daysAgo(400) },
        { action: `e2e.jobs.recent.${tag}` },
      ],
    });
    await prisma.jobRun.create({
      data: { job: `e2e-old-${tag}`, instance: 'x', startedAt: daysAgo(40), status: 'OK' },
    });

    const outcome = await scheduler.runNow('cleanup');
    expect(outcome.status).toBe('ok');

    const ids = (
      await prisma.outboxEvent.findMany({
        where: { id: { in: [oldPublished.id, recentPublished.id, oldPending.id, oldFailed.id] } },
        select: { id: true },
      })
    ).map((r) => r.id);
    expect(ids.sort()).toEqual([recentPublished.id, oldPending.id, oldFailed.id].sort());

    expect(
      (
        await prisma.processedMessage.findMany({
          where: { consumer: 'e2e-jobs', messageId: { endsWith: tag } },
        })
      ).map((r) => r.messageId),
    ).toEqual([`new-${tag}`]);
    expect(
      await prisma.stripeWebhookEvent.count({ where: { stripeEventId: `evt_e2e_old_${tag}` } }),
    ).toBe(0);
    expect(
      (await prisma.refreshToken.findMany({ where: { tokenHash: { endsWith: tag } } }))
        .map((r) => r.tokenHash)
        .sort(),
    ).toEqual([`e2e-revoked-live-${tag}`, `e2e-valid-${tag}`]);
    expect(await prisma.auditLog.count({ where: { action: `e2e.jobs.old.${tag}` } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: `e2e.jobs.recent.${tag}` } })).toBe(1);
    expect(await prisma.jobRun.count({ where: { job: `e2e-old-${tag}` } })).toBe(0);
  });

  it('still refuses to delete or change audit rows outside the cleanup job', async () => {
    await expect(
      prisma.$executeRaw`DELETE FROM audit_logs WHERE action LIKE 'e2e.jobs.recent.%'`,
    ).rejects.toThrow();
    await expect(
      prisma.$executeRaw`UPDATE audit_logs SET action = 'tampered' WHERE action LIKE 'e2e.jobs.recent.%'`,
    ).rejects.toThrow();
  });

  // ── admin status ──
  it('shows job status to administrators only', async () => {
    await scheduler.runNow('cleanup');

    const res = await auth.api().get('/admin/jobs').expect(200);
    const body = res.body as {
      healthy: boolean;
      jobs: {
        name: string;
        healthy: boolean;
        running: boolean;
        lastRun: { status: string } | null;
      }[];
    };
    expect(body.jobs.map((j) => j.name)).toEqual([...JOB_NAMES]);
    const cleanup = body.jobs.find((j) => j.name === 'cleanup');
    expect(cleanup).toMatchObject({ healthy: true, running: false, lastRun: { status: 'OK' } });

    const customer = await auth.createUser('CUSTOMER');
    await auth.api(customer).get('/admin/jobs').expect(403);
    await auth.api('anon').get('/admin/jobs').expect(401);
  });
});
