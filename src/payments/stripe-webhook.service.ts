import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable, Logger } from '@nestjs/common';
import type Stripe from 'stripe';
import type { OrderStatus, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ReservationsService } from '../reservations/reservations.service';
import { byVariantId } from '../reservations/reservations.utils';
import { enqueueOutbox } from '../outbox/outbox';
import { statusForRefundTotal } from './payments.utils';
import { StripeService } from './stripe.service';

type Tx = Prisma.TransactionClient;
type After = Array<() => Promise<void>>;

type OrderForPayment = {
  id: string;
  userId: string;
  orderNumber: string;
  status: OrderStatus;
  totalMinor: number;
  items: { variantId: string; quantity: number }[];
};

const RECOVERABLE: OrderStatus[] = ['PENDING_PAYMENT', 'CANCELLED', 'PAYMENT_FAILED'];

/**
 * Stripe is the source of truth for payment state. Every event is recorded and applied in ONE
 * transaction, so a failure rolls back the event row too and Stripe's retry reprocesses it.
 * Lock order everywhere: reservations, then payment, then order.
 */
@Injectable()
export class StripeWebhookService {
  private readonly logger = new Logger(StripeWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly reservations: ReservationsService,
  ) {}

  async handle(event: Stripe.Event): Promise<{ status: 'processed' | 'duplicate' }> {
    // Network calls happen before the transaction so no DB connection waits on Stripe
    const refunds =
      event.type === 'charge.refunded' ? await this.listRefunds(event.data.object) : [];
    const after: After = [];

    const status = await this.prisma.$transaction(
      async (tx) => {
        if (!(await this.recordEvent(tx, event))) return 'duplicate' as const;
        await this.dispatch(tx, event, refunds, after);
        return 'processed' as const;
      },
      { timeout: 15_000 },
    );

    for (const run of after) {
      try {
        await run();
      } catch (error) {
        this.logger.error(
          `Post-commit action failed for event ${event.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return { status };
  }

  /** false = this event id was already processed (concurrent duplicates wait on the unique index). */
  private async recordEvent(tx: Tx, event: Stripe.Event): Promise<boolean> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO stripe_webhook_events (id, stripe_event_id, type, received_at, processed_at)
      VALUES (${randomUUID()}::uuid, ${event.id}, ${event.type}, now(), now())
      ON CONFLICT (stripe_event_id) DO NOTHING
      RETURNING id`;
    return rows.length > 0;
  }

  private async dispatch(tx: Tx, event: Stripe.Event, refunds: Stripe.Refund[], after: After) {
    switch (event.type) {
      case 'checkout.session.completed':
        return this.onSessionCompleted(tx, event.data.object, after);
      case 'checkout.session.expired':
        return this.onSessionExpired(tx, event.data.object);
      case 'payment_intent.payment_failed':
        return this.onPaymentFailed(tx, event.data.object);
      case 'charge.refunded':
        return this.onChargeRefunded(tx, event.data.object, refunds);
      default:
        this.logger.debug(`Ignoring event ${event.id} (${event.type})`);
    }
  }

  // ───────── checkout.session.completed ─────────

  private async onSessionCompleted(tx: Tx, session: Stripe.Checkout.Session, after: After) {
    if (session.payment_status !== 'paid') {
      this.logger.warn(
        `Session ${session.id} completed but not paid (${session.payment_status}), ignored`,
      );
      return;
    }
    const payment = await tx.payment.findUnique({
      where: { stripeSessionId: session.id },
      select: { id: true, orderId: true, status: true, amountMinor: true, currency: true },
    });
    if (!payment) {
      this.logger.warn(`Session ${session.id} matches no payment, ignored`);
      return;
    }
    if (payment.status !== 'PENDING') return; // already applied

    if (
      session.amount_total !== payment.amountMinor ||
      session.currency?.toUpperCase() !== payment.currency
    ) {
      this.logger.error(
        `Amount mismatch on session ${session.id} (payment ${payment.id}): manual review needed`,
      );
      return;
    }

    const intentId =
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : (session.payment_intent?.id ?? null);
    const order = await tx.order.findUniqueOrThrow({
      where: { id: payment.orderId },
      select: {
        id: true,
        userId: true,
        orderNumber: true,
        status: true,
        totalMinor: true,
        items: { select: { variantId: true, quantity: true } },
      },
    });

    // Normal path: the reservation is still ACTIVE -> becomes a sale (the gate lets one flow win)
    const consumed = await this.reservations.consume(tx, order.id);
    if (consumed.length > 0) {
      await this.markPaid(tx, payment.id, order, intentId, ['PENDING_PAYMENT'], false);
      return;
    }
    await this.recoverLatePayment(tx, payment, order, intentId, after);
  }

  /** The reservation was released or expired before the payment arrived. */
  private async recoverLatePayment(
    tx: Tx,
    payment: { id: string; amountMinor: number },
    order: OrderForPayment,
    intentId: string | null,
    after: After,
  ) {
    if (!RECOVERABLE.includes(order.status)) {
      this.logger.error(
        `Payment ${payment.id} arrived for order ${order.id} in status ${order.status}: manual review`,
      );
      return;
    }

    // Lock the stock rows (variant order) and check that every line is still sellable
    const items = [...order.items].sort(byVariantId);
    let enough = true;
    for (const item of items) {
      const rows = await tx.$queryRaw<{ onHand: number; reserved: number }[]>`
        SELECT on_hand AS "onHand", reserved FROM inventory_items
        WHERE variant_id = ${item.variantId}::uuid FOR UPDATE`;
      if (!rows[0] || rows[0].onHand - rows[0].reserved < item.quantity) enough = false;
    }

    if (enough) {
      for (const item of items) {
        await tx.$queryRaw`
          UPDATE inventory_items
          SET on_hand = on_hand - ${item.quantity}::int, version = version + 1, updated_at = now()
          WHERE variant_id = ${item.variantId}::uuid
          RETURNING variant_id`;
      }
      await tx.inventoryMovement.createMany({
        data: items.map((i) => ({
          variantId: i.variantId,
          type: 'SALE' as const,
          deltaOnHand: -i.quantity,
          deltaReserved: 0,
          reason: 'Sale completed (payment received after the reservation was released)',
          referenceType: 'ORDER',
          referenceId: order.id,
        })),
      });
      await this.markPaid(tx, payment.id, order, intentId, RECOVERABLE, true);
      this.logger.warn(
        `Order ${order.id} recovered: payment arrived after reservation release, stock was still free`,
      );
      return;
    }

    // Out of stock: keep the order cancelled, record the payment, refund it right after commit
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: 'PAID',
        stripePaymentIntentId: intentId,
        failureReason: 'PAID_AFTER_EXPIRY_NO_STOCK',
      },
    });
    await tx.order.updateMany({
      where: { id: order.id, status: { in: RECOVERABLE } },
      data: { status: 'CANCELLED', cancelReason: 'PAID_AFTER_EXPIRY', cancelledAt: new Date() },
    });
    await enqueueOutbox(tx, {
      aggregateId: order.id,
      type: 'payment.auto_refund_required',
      payload: { orderId: order.id, paymentId: payment.id, amountMinor: payment.amountMinor },
    });
    this.logger.warn(
      `Order ${order.id} paid after expiry with no stock left: auto-refunding payment ${payment.id}`,
    );
    after.push(() => this.autoRefund(order.id, payment.id, intentId, payment.amountMinor));
  }

  private async autoRefund(
    orderId: string,
    paymentId: string,
    intentId: string | null,
    amountMinor: number,
  ) {
    if (!intentId) {
      this.logger.error(
        `Cannot auto-refund payment ${paymentId} (order ${orderId}): no payment intent, refund manually`,
      );
      return;
    }
    await this.stripe.client.refunds.create(
      {
        payment_intent: intentId,
        amount: amountMinor,
        metadata: { orderId, paymentId, restock: 'false', note: 'PAID_AFTER_EXPIRY_NO_STOCK' },
      },
      { idempotencyKey: `auto-refund:${paymentId}` },
    );
  }

  private async markPaid(
    tx: Tx,
    paymentId: string,
    order: OrderForPayment,
    intentId: string | null,
    from: OrderStatus[],
    recovered: boolean,
  ) {
    await tx.payment.update({
      where: { id: paymentId },
      data: { status: 'PAID', stripePaymentIntentId: intentId, failureReason: null },
    });
    const { count } = await tx.order.updateMany({
      where: { id: order.id, status: { in: from } },
      data: { status: 'PAID', paidAt: new Date(), cancelReason: null, cancelledAt: null },
    });
    if (count === 0)
      throw new Error(`Order ${order.id} could not be marked paid (status ${order.status})`);

    // Only the lines that were paid for; items the customer added afterwards stay in the cart
    await tx.cartItem.deleteMany({
      where: {
        cart: { userId: order.userId },
        variantId: { in: order.items.map((i) => i.variantId) },
      },
    });
    await enqueueOutbox(tx, {
      aggregateId: order.id,
      type: 'order.paid',
      payload: {
        orderId: order.id,
        orderNumber: order.orderNumber,
        totalMinor: order.totalMinor,
        recovered,
      },
    });
  }

  // ───────── checkout.session.expired ─────────

  private async onSessionExpired(tx: Tx, session: Stripe.Checkout.Session) {
    const payment = await tx.payment.findUnique({
      where: { stripeSessionId: session.id },
      select: { id: true, orderId: true, status: true, failureReason: true },
    });
    if (!payment || payment.status !== 'PENDING') return;

    // Reservations first (returns [] when a cancel or expiry already released them)
    await this.reservations.expireOrder(tx, payment.orderId);

    const declined = payment.failureReason !== null;
    await tx.payment.updateMany({
      where: { id: payment.id, status: 'PENDING' },
      data: { status: declined ? 'FAILED' : 'EXPIRED' },
    });
    const { count } = await tx.order.updateMany({
      where: { id: payment.orderId, status: 'PENDING_PAYMENT' },
      data: declined
        ? { status: 'PAYMENT_FAILED', cancelReason: 'PAYMENT_FAILED', cancelledAt: new Date() }
        : { status: 'CANCELLED', cancelReason: 'PAYMENT_EXPIRED', cancelledAt: new Date() },
    });
    if (count > 0) {
      await enqueueOutbox(tx, {
        aggregateId: payment.orderId,
        type: 'order.cancelled',
        payload: {
          orderId: payment.orderId,
          reason: declined ? 'PAYMENT_FAILED' : 'PAYMENT_EXPIRED',
        },
      });
    }
  }

  // ───────── payment_intent.payment_failed ─────────

  /** A decline is not final: Checkout lets the customer retry until the session expires. */
  private async onPaymentFailed(tx: Tx, intent: Stripe.PaymentIntent) {
    const paymentId = intent.metadata?.paymentId;
    if (!paymentId) {
      this.logger.debug(`payment_intent ${intent.id} has no paymentId metadata, ignored`);
      return;
    }
    await tx.payment.updateMany({
      where: { id: paymentId, status: 'PENDING' },
      data: {
        failureReason: (intent.last_payment_error?.message ?? 'Payment failed').slice(0, 200),
        stripePaymentIntentId: intent.id,
      },
    });
  }

  // ───────── charge.refunded ─────────

  private listRefunds(charge: Stripe.Charge) {
    return this.stripe.client.refunds
      .list({ charge: charge.id, limit: 100 })
      .then((list) => list.data);
  }

  private async onChargeRefunded(tx: Tx, charge: Stripe.Charge, refunds: Stripe.Refund[]) {
    const intentId =
      typeof charge.payment_intent === 'string'
        ? charge.payment_intent
        : (charge.payment_intent?.id ?? null);
    if (!intentId) {
      this.logger.warn(`charge ${charge.id} has no payment intent, ignored`);
      return;
    }
    const found = await tx.payment.findUnique({
      where: { stripePaymentIntentId: intentId },
      select: { id: true },
    });
    // Out-of-order delivery: the payment is not recorded yet. A non-2xx makes Stripe retry later.
    if (!found) throw new ConflictException('Payment not recorded yet, retry later');

    await tx.$queryRaw`SELECT id FROM payments WHERE id = ${found.id}::uuid FOR UPDATE`;
    const payment = await tx.payment.findUniqueOrThrow({
      where: { id: found.id },
      select: { id: true, orderId: true, amountMinor: true, refundedMinor: true },
    });

    // Totals only ever grow: an older event delivered late cannot lower them
    const total = Math.min(charge.amount_refunded, payment.amountMinor);
    if (total > payment.refundedMinor) {
      const status = statusForRefundTotal(payment.amountMinor, total);
      await tx.payment.update({
        where: { id: payment.id },
        data: { refundedMinor: total, status },
      });
      await tx.order.updateMany({
        where: { id: payment.orderId, status: { in: ['PAID', 'SHIPPED', 'PARTIALLY_REFUNDED'] } },
        data: { status },
      });
      await enqueueOutbox(tx, {
        aggregateId: payment.orderId,
        type: 'payment.refunded',
        payload: { orderId: payment.orderId, paymentId: payment.id, refundedMinor: total, status },
      });
    }

    for (const refund of refunds) {
      if (
        refund.status === 'succeeded' &&
        refund.metadata?.restock === 'true' &&
        refund.metadata.orderId === payment.orderId
      ) {
        await this.restock(tx, payment.orderId, refund.id);
      }
    }
  }

  /** Returns the order's items to stock, once per Stripe refund (ledger unique index is the backstop). */
  private async restock(tx: Tx, orderId: string, refundId: string) {
    const done = await tx.inventoryMovement.findFirst({
      where: { referenceType: 'REFUND', referenceId: refundId, type: 'RETURN' },
      select: { id: true },
    });
    if (done) return; // the payment row lock above serializes concurrent events, so this check is safe

    const items = await tx.orderItem.findMany({
      where: { orderId },
      select: { variantId: true, quantity: true },
      orderBy: { variantId: 'asc' },
    });
    for (const item of items) {
      await tx.$queryRaw`
        UPDATE inventory_items
        SET on_hand = on_hand + ${item.quantity}::int, version = version + 1, updated_at = now()
        WHERE variant_id = ${item.variantId}::uuid
        RETURNING variant_id`;
    }
    await tx.inventoryMovement.createMany({
      data: items.map((i) => ({
        variantId: i.variantId,
        type: 'RETURN' as const,
        deltaOnHand: i.quantity,
        deltaReserved: 0,
        reason: 'Refund restock: items returned in good condition',
        referenceType: 'REFUND',
        referenceId: refundId,
      })),
    });
  }
}
