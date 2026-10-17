import type { EventEnvelope } from '../messaging/envelope';
import {
  inventoryMessage,
  isStale,
  orderMessages,
  realtimeMessageSchema,
  roomsFor,
} from './realtime.messages';

const order = {
  userId: 'u1',
  orderNumber: 'VLX-20261017-ABCD1234',
  status: 'PAID',
  totalMinor: 1000,
  currency: 'EUR',
  createdAt: new Date('2026-10-17T12:00:00Z'),
};
const envelope = (type: string, payload: Record<string, unknown> = {}): EventEnvelope => ({
  id: 'evt-1',
  type,
  aggregateType: 'order',
  aggregateId: 'o1',
  occurredAt: '2026-10-17T12:00:00.000Z',
  payload,
});

describe('roomsFor', () => {
  it('gives customers only their own room', () => {
    expect(roomsFor('u1', 'CUSTOMER')).toEqual(['user:u1']);
  });

  it('gives operators inventory and admins everything', () => {
    expect(roomsFor('u1', 'INVENTORY_OPERATOR')).toEqual(['user:u1', 'inventory']);
    expect(roomsFor('u1', 'ADMIN')).toEqual(['user:u1', 'orders', 'inventory']);
  });
});

describe('orderMessages', () => {
  it('sends new orders to the admin room only', () => {
    const [m] = orderMessages(envelope('order.created'), order);
    expect(m.rooms).toEqual(['orders']);
    expect(m.event).toBe('order:created');
    expect(m.data).toMatchObject({ orderId: 'o1', totalMinor: 1000 });
  });

  it('sends status changes to admins and the owner, without personal data', () => {
    const [m] = orderMessages(envelope('order.paid'), order);
    expect(m.rooms).toEqual(['orders', 'user:u1']);
    expect(JSON.stringify(m.data)).not.toMatch(/email|address|name"/i);
  });

  it('adds reservation:expired only for an expiry cancellation', () => {
    expect(
      orderMessages(envelope('order.cancelled', { reason: 'CUSTOMER_CANCELLED' }), order),
    ).toHaveLength(1);
    const messages = orderMessages(
      envelope('order.cancelled', { reason: 'RESERVATION_EXPIRED' }),
      order,
    );
    expect(messages.map((m) => m.event)).toEqual(['order:updated', 'reservation:expired']);
    expect(messages[1].rooms).toEqual(['orders', 'inventory']);
  });

  it('flags auto-refunds for admins and ignores unknown types', () => {
    expect(orderMessages(envelope('payment.auto_refund_required'), order)[0]).toMatchObject({
      event: 'order:alert',
    });
    expect(orderMessages(envelope('something.else'), order)).toEqual([]);
  });
});

describe('inventoryMessage', () => {
  it('computes availability and the low-stock flag', () => {
    const m = inventoryMessage('e1', [
      { variantId: 'v1', sku: 'S1', onHand: 6, reserved: 2, reorderLevel: 5 },
    ]);
    expect(m?.data.items).toEqual([
      {
        variantId: 'v1',
        sku: 'S1',
        onHand: 6,
        reserved: 2,
        available: 4,
        reorderLevel: 5,
        lowStock: true,
      },
    ]);
    expect(inventoryMessage('e1', [])).toBeNull();
  });
});

describe('isStale and the message schema', () => {
  it('drops events older than 2 minutes', () => {
    const now = Date.parse('2026-10-17T12:10:00Z');
    expect(isStale('2026-10-17T12:09:30Z', now)).toBe(false);
    expect(isStale('2026-10-17T12:07:00Z', now)).toBe(true);
  });

  it('rejects malformed messages', () => {
    expect(realtimeMessageSchema.safeParse({ rooms: [], event: 'x', data: {} }).success).toBe(
      false,
    );
    expect(
      realtimeMessageSchema.safeParse({ rooms: ['orders'], event: 'x', data: {} }).success,
    ).toBe(true);
  });
});
