import { BadRequestException, ConflictException } from '@nestjs/common';
import type Stripe from 'stripe';

export const SESSION_MINUTES = 31; // Stripe's minimum is 30; one minute of slack for latency
export const RESERVATION_MARGIN_SECONDS = 120; // the hold outlives the session by at least this
const STRIPE_NAME_MAX = 250;

export function sessionExpiryUnix(now: Date): number {
  return Math.floor(now.getTime() / 1000) + SESSION_MINUTES * 60;
}

export function reservationDeadline(sessionExpiresUnix: number): Date {
  return new Date((sessionExpiresUnix + RESERVATION_MARGIN_SECONDS) * 1000);
}

type OrderForLines = {
  currency: string;
  shippingMinor: number;
  items: { nameSnapshot: string; skuSnapshot: string; unitPriceMinor: number; quantity: number }[];
};

/** Line items built only from the order snapshot (database values, minor units). Shipping is its own line. */
export function buildLineItems(
  order: OrderForLines,
): Stripe.Checkout.SessionCreateParams.LineItem[] {
  const currency = order.currency.toLowerCase();
  const lines: Stripe.Checkout.SessionCreateParams.LineItem[] = order.items.map((i) => ({
    quantity: i.quantity,
    price_data: {
      currency,
      unit_amount: i.unitPriceMinor,
      product_data: {
        name: i.nameSnapshot.slice(0, STRIPE_NAME_MAX),
        metadata: { sku: i.skuSnapshot },
      },
    },
  }));
  if (order.shippingMinor > 0) {
    lines.push({
      quantity: 1,
      price_data: {
        currency,
        unit_amount: order.shippingMinor,
        product_data: { name: 'Shipping', metadata: { sku: 'SHIPPING' } },
      },
    });
  }
  return lines;
}

export function lineItemsTotal(lines: Stripe.Checkout.SessionCreateParams.LineItem[]): number {
  return lines.reduce((sum, l) => sum + (l.price_data?.unit_amount ?? 0) * (l.quantity ?? 1), 0);
}

/** Payment/order status once `refundedMinor > 0`. */
export function statusForRefundTotal(
  amountMinor: number,
  refundedMinor: number,
): 'REFUNDED' | 'PARTIALLY_REFUNDED' {
  return refundedMinor >= amountMinor ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
}

/** Validates an admin refund request against what is still refundable. */
export function planRefund(input: {
  amountMinor: number;
  refundedMinor: number;
  requestedMinor?: number;
  restock: boolean;
}): { amount: number; full: boolean } {
  const remaining = input.amountMinor - input.refundedMinor;
  if (remaining <= 0) throw new ConflictException('This payment is already fully refunded');

  const amount = input.requestedMinor ?? remaining;
  if (amount < 1) throw new BadRequestException('The refund amount must be at least 1');
  if (amount > remaining) {
    throw new BadRequestException(
      `Cannot refund more than the remaining ${remaining} (minor units)`,
    );
  }

  const full = input.refundedMinor === 0 && amount === input.amountMinor;
  if (input.restock && !full) {
    throw new BadRequestException(
      'Restocking is only supported for a full refund of the whole order',
    );
  }
  return { amount, full };
}
