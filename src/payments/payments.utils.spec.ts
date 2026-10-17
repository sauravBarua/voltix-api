import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  buildLineItems,
  lineItemsTotal,
  planRefund,
  reservationDeadline,
  sessionExpiryUnix,
  statusForRefundTotal,
} from './payments.utils';

describe('session and reservation timing', () => {
  it('expires the session in 31 minutes, at least Stripe minimum of 30', () => {
    const now = new Date('2026-10-17T12:00:00Z');
    const unix = sessionExpiryUnix(now);
    expect(unix - Math.floor(now.getTime() / 1000)).toBe(31 * 60);
  });

  it('keeps the reservation alive 2 minutes past the session', () => {
    expect(reservationDeadline(1_000_000).getTime()).toBe((1_000_000 + 120) * 1000);
  });
});

describe('buildLineItems', () => {
  const order = {
    currency: 'EUR',
    shippingMinor: 990,
    items: [
      { nameSnapshot: 'Laptop - 16 GB', skuSnapshot: 'LAP-1', unitPriceMinor: 1000, quantity: 2 },
      { nameSnapshot: 'Mouse', skuSnapshot: 'MOU-1', unitPriceMinor: 250, quantity: 1 },
    ],
  };

  it('uses lowercase currency, minor units and a separate shipping line', () => {
    const lines = buildLineItems(order);
    expect(lines).toHaveLength(3);
    expect(lines[0].price_data).toMatchObject({ currency: 'eur', unit_amount: 1000 });
    expect(lines[2].price_data?.unit_amount).toBe(990);
    expect(lineItemsTotal(lines)).toBe(2 * 1000 + 250 + 990);
  });

  it('omits shipping when it is free and truncates long names', () => {
    const lines = buildLineItems({
      ...order,
      shippingMinor: 0,
      items: [{ ...order.items[0], nameSnapshot: 'x'.repeat(400) }],
    });
    expect(lines).toHaveLength(1);
    expect(lines[0].price_data?.product_data?.name).toHaveLength(250);
  });
});

describe('statusForRefundTotal', () => {
  it('is REFUNDED only when everything came back', () => {
    expect(statusForRefundTotal(1000, 1000)).toBe('REFUNDED');
    expect(statusForRefundTotal(1000, 400)).toBe('PARTIALLY_REFUNDED');
  });
});

describe('planRefund', () => {
  const base = { amountMinor: 1000, refundedMinor: 0, restock: false };

  it('refunds the remaining amount by default and flags a full refund', () => {
    expect(planRefund(base)).toEqual({ amount: 1000, full: true });
    expect(planRefund({ ...base, requestedMinor: 1000 })).toEqual({ amount: 1000, full: true });
  });

  it('treats a smaller amount as partial', () => {
    expect(planRefund({ ...base, requestedMinor: 400 })).toEqual({ amount: 400, full: false });
    expect(planRefund({ ...base, refundedMinor: 400 })).toEqual({ amount: 600, full: false });
  });

  it('refuses more than what remains, and refunds of a refunded payment', () => {
    expect(() => planRefund({ ...base, requestedMinor: 1001 })).toThrow(BadRequestException);
    expect(() => planRefund({ ...base, refundedMinor: 1000 })).toThrow(ConflictException);
  });

  it('allows restock only for a full refund of the whole order', () => {
    expect(planRefund({ ...base, restock: true }).full).toBe(true);
    expect(() => planRefund({ ...base, restock: true, requestedMinor: 400 })).toThrow(
      BadRequestException,
    );
    expect(() => planRefund({ ...base, restock: true, refundedMinor: 400 })).toThrow(
      BadRequestException,
    );
  });
});
