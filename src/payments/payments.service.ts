import { randomUUID } from 'node:crypto';
import {
  BadGatewayException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import Stripe from 'stripe';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ReservationHooks } from '../reservations/reservation-hooks';
import { ReservationsService } from '../reservations/reservations.service';
import type { RefundDto } from './payments.dto';
import {
  buildLineItems,
  lineItemsTotal,
  planRefund,
  reservationDeadline,
  sessionExpiryUnix,
} from './payments.utils';
import { StripeService } from './stripe.service';

type Tx = Prisma.TransactionClient;

const orderForPay = {
  id: true,
  orderNumber: true,
  status: true,
  totalMinor: true,
  shippingMinor: true,
  currency: true,
  user: { select: { email: true } },
  items: {
    select: { skuSnapshot: true, nameSnapshot: true, unitPriceMinor: true, quantity: true },
  },
} satisfies Prisma.OrderSelect;
type OrderForPay = Prisma.OrderGetPayload<{ select: typeof orderForPay }>;

@Injectable()
export class PaymentsService implements OnModuleInit {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly reservations: ReservationsService,
    private readonly hooks: ReservationHooks,
  ) {}

  onModuleInit() {
    // When reservations expire, close the matching Checkout Sessions
    this.hooks.onExpired((orderIds) => this.onReservationsExpired(orderIds));
  }

  /** Creates (or returns the open) Checkout Session of an unpaid order. Amounts come from the database only. */
  async createCheckoutSession(userId: string, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, userId },
      select: orderForPay,
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status !== 'PENDING_PAYMENT') {
      throw new ConflictException(`Order is not awaiting payment (status: ${order.status})`);
    }
    return this.prisma.$transaction((tx) => this.openSession(tx, order), {
      timeout: 20_000,
      maxWait: 5_000,
    });
  }

  /**
   * Customer cancellation: expire the open session so the customer can no longer pay.
   * 409 when the payment already completed (the webhook is about to confirm it).
   */
  async expireOpenSession(orderId: string): Promise<void> {
    const payment = await this.prisma.payment.findFirst({
      where: { orderId, status: 'PENDING' },
      select: { stripeSessionId: true },
    });
    if (!payment) return;

    try {
      await this.stripe.client.checkout.sessions.expire(payment.stripeSessionId);
    } catch (error) {
      if (!(error instanceof Stripe.errors.StripeError)) throw error;
      const session = await this.stripe.client.checkout.sessions
        .retrieve(payment.stripeSessionId)
        .catch(() => null);
      if (session?.status === 'expired') return;
      if (session?.status === 'complete') {
        throw new ConflictException(
          'Your payment was received and is being confirmed. The order cannot be cancelled.',
        );
      }
      throw this.stripeFailure(error);
    }
  }

  /** Admin refund. Only asks Stripe; the payment, order and restock are finalized by `charge.refunded`. */
  async refund(orderId: string, idempotencyKey: string, dto: RefundDto) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true },
    });
    if (!order) throw new NotFoundException('Order not found');

    const payment = await this.prisma.payment.findFirst({
      where: { orderId, status: { in: ['PAID', 'PARTIALLY_REFUNDED'] } },
      select: { id: true, stripePaymentIntentId: true, amountMinor: true, refundedMinor: true },
    });
    if (!payment?.stripePaymentIntentId)
      throw new ConflictException('This order has no paid payment to refund');

    const plan = planRefund({
      amountMinor: payment.amountMinor,
      refundedMinor: payment.refundedMinor,
      requestedMinor: dto.amountMinor,
      restock: dto.restock,
    });

    try {
      const refund = await this.stripe.client.refunds.create(
        {
          payment_intent: payment.stripePaymentIntentId,
          amount: plan.amount,
          reason: 'requested_by_customer',
          metadata: {
            orderId,
            paymentId: payment.id,
            restock: String(dto.restock),
            note: dto.reason.slice(0, 200),
          },
        },
        { idempotencyKey: `refund:${orderId}:${idempotencyKey}` },
      );
      return {
        stripeRefundId: refund.id,
        status: refund.status ?? null,
        amountMinor: plan.amount,
        restock: dto.restock,
        full: plan.full,
        note: 'The order and stock update when Stripe confirms the refund (charge.refunded webhook).',
      };
    } catch (error) {
      // Stripe is the final guard against over-refunds or double refunds
      throw this.stripeFailure(error, true);
    }
  }

  // ───────── internals ─────────

  private async openSession(tx: Tx, order: OrderForPay) {
    // One /pay at a time per order: concurrent calls wait here, then find the committed Payment
    await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext(${`pay:${order.id}`}::text))) AS t`;

    const current = await tx.order.findUnique({
      where: { id: order.id },
      select: { status: true },
    });
    if (current?.status !== 'PENDING_PAYMENT')
      throw new ConflictException('Order is not awaiting payment');

    const existing = await tx.payment.findFirst({
      where: { orderId: order.id, status: 'PENDING' },
      select: { id: true, stripeSessionId: true },
    });
    if (existing) return this.reuseSession(existing);

    const attempt = (await tx.payment.count({ where: { orderId: order.id } })) + 1;
    const expiresAtUnix = sessionExpiryUnix(new Date());

    // The hold must outlive the session, so Stripe ends the session before the stock can be released
    const extended = await this.reservations.extendHold(
      tx,
      order.id,
      reservationDeadline(expiresAtUnix),
    );
    if (extended === 0)
      throw new ConflictException('Your reservation has expired. Please check out again.');

    const lineItems = buildLineItems(order);
    if (lineItemsTotal(lineItems) !== order.totalMinor) {
      throw new Error(`Order ${order.id}: line items do not add up to the order total`);
    }

    const paymentId = randomUUID();
    const idempotencyKey = `checkout-session:${order.id}:${attempt}`;
    const metadata = { orderId: order.id, orderNumber: order.orderNumber, paymentId };

    let session: Stripe.Checkout.Session;
    try {
      session = await this.stripe.client.checkout.sessions.create(
        {
          mode: 'payment',
          client_reference_id: order.id,
          customer_email: order.user.email,
          line_items: lineItems,
          metadata,
          payment_intent_data: { metadata },
          expires_at: expiresAtUnix,
          success_url: `${this.stripe.frontendUrl}/checkout/success?order=${order.id}`,
          cancel_url: `${this.stripe.frontendUrl}/checkout/cancel?order=${order.id}`,
        },
        { idempotencyKey },
      );
    } catch (error) {
      throw this.stripeFailure(error);
    }
    if (!session.url)
      throw new BadGatewayException('The payment provider returned no checkout URL');

    try {
      await tx.payment.create({
        data: {
          id: paymentId,
          orderId: order.id,
          status: 'PENDING',
          stripeSessionId: session.id,
          amountMinor: order.totalMinor,
          currency: order.currency,
          idempotencyKey,
        },
        select: { id: true },
      });
    } catch (error) {
      // Do not leave a payable session behind without a Payment row
      await this.stripe.client.checkout.sessions.expire(session.id).catch(() => undefined);
      throw error;
    }

    return {
      paymentId,
      sessionId: session.id,
      url: session.url,
      expiresAt: new Date(expiresAtUnix * 1000).toISOString(),
    };
  }

  private async reuseSession(existing: { id: string; stripeSessionId: string }) {
    let session: Stripe.Checkout.Session;
    try {
      session = await this.stripe.client.checkout.sessions.retrieve(existing.stripeSessionId);
    } catch (error) {
      throw this.stripeFailure(error);
    }
    if (session.status === 'open' && session.url) {
      return {
        paymentId: existing.id,
        sessionId: session.id,
        url: session.url,
        expiresAt: new Date(session.expires_at * 1000).toISOString(),
      };
    }
    if (session.status === 'complete') {
      throw new ConflictException('Your payment was received and is being confirmed');
    }
    throw new ConflictException('The payment session has expired');
  }

  /** Hook: reservations of these orders expired, so close their Checkout Sessions (best effort). */
  private async onReservationsExpired(orderIds: string[]) {
    for (const orderId of orderIds) {
      try {
        await this.expireOpenSession(orderId);
      } catch (error) {
        // A completed session means a payment is racing the expiry: the webhook handles it
        this.logger.warn(
          `Session of expired order ${orderId} not closed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private stripeFailure(error: unknown, invalidAsConflict = false): Error {
    if (error instanceof Stripe.errors.StripeIdempotencyError) {
      return new ConflictException(
        'A payment request with this key is already in progress, retry shortly',
      );
    }
    if (error instanceof Stripe.errors.StripeInvalidRequestError && invalidAsConflict) {
      return new ConflictException(error.message);
    }
    if (error instanceof Stripe.errors.StripeError) {
      // Never log request or response bodies, only the error classification
      this.logger.error(
        `Stripe error ${error.type}${error.code ? `/${error.code}` : ''}: ${error.message}`,
      );
      return new BadGatewayException('The payment provider returned an error, please retry');
    }
    return error instanceof Error ? error : new Error(String(error));
  }
}
