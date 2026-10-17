import { z } from 'zod';
import type { Role } from '../generated/prisma/client';
import type { EventEnvelope } from '../messaging/envelope';

export const ROOMS = { orders: 'orders', inventory: 'inventory' } as const;
export const userRoom = (userId: string) => `user:${userId}`;

/** Rooms a socket may join, decided by role only. Customers never get staff rooms. */
export function roomsFor(userId: string, role: Role): string[] {
  const rooms = [userRoom(userId)];
  if (role === 'ADMIN') rooms.push(ROOMS.orders, ROOMS.inventory);
  if (role === 'INVENTORY_OPERATOR') rooms.push(ROOMS.inventory);
  return rooms;
}

export const realtimeMessageSchema = z.object({
  rooms: z.array(z.string().min(1)).min(1).max(5),
  event: z.string().min(1),
  data: z.record(z.string(), z.unknown()),
});
export type RealtimeMessage = z.infer<typeof realtimeMessageSchema>;

export const ORDER_EVENT_TYPES = [
  'order.created',
  'order.paid',
  'order.cancelled',
  'order.shipped',
  'payment.refunded',
  'payment.auto_refund_required',
] as const;

const STALE_AFTER_MS = 120_000;
/** Real-time is about "now": events that waited more than 2 minutes (outage, restart) are dropped. */
export const isStale = (occurredAt: string, now = Date.now()) =>
  now - Date.parse(occurredAt) > STALE_AFTER_MS;

export type StockInfo = {
  variantId: string;
  sku: string;
  onHand: number;
  reserved: number;
  reorderLevel: number;
};

export function inventoryMessage(eventId: string, rows: StockInfo[]): RealtimeMessage | null {
  if (rows.length === 0) return null;
  return {
    rooms: [ROOMS.inventory],
    event: 'inventory:changed',
    data: {
      id: eventId,
      items: rows.map((r) => {
        const available = r.onHand - r.reserved;
        return {
          variantId: r.variantId,
          sku: r.sku,
          onHand: r.onHand,
          reserved: r.reserved,
          available,
          reorderLevel: r.reorderLevel,
          lowStock: available <= r.reorderLevel,
        };
      }),
    },
  };
}

export type OrderInfo = {
  userId: string;
  orderNumber: string;
  status: string;
  totalMinor: number;
  currency: string;
  createdAt: Date;
};

/** Order data comes from the database at delivery time, so a late event still shows the current status. */
export function orderMessages(event: EventEnvelope, order: OrderInfo): RealtimeMessage[] {
  const base = {
    id: event.id,
    orderId: event.aggregateId,
    orderNumber: order.orderNumber,
    status: order.status,
  };
  switch (event.type) {
    case 'order.created':
      return [
        {
          rooms: [ROOMS.orders],
          event: 'order:created',
          data: {
            ...base,
            totalMinor: order.totalMinor,
            currency: order.currency,
            createdAt: order.createdAt.toISOString(),
          },
        },
      ];
    case 'payment.auto_refund_required':
      return [
        { rooms: [ROOMS.orders], event: 'order:alert', data: { ...base, kind: 'AUTO_REFUND' } },
      ];
    case 'order.paid':
    case 'order.shipped':
    case 'order.cancelled':
    case 'payment.refunded': {
      const messages: RealtimeMessage[] = [
        {
          rooms: [ROOMS.orders, userRoom(order.userId)],
          event: 'order:updated',
          data: { ...base, type: event.type },
        },
      ];
      if (event.type === 'order.cancelled' && event.payload.reason === 'RESERVATION_EXPIRED') {
        messages.push({
          rooms: [ROOMS.orders, ROOMS.inventory],
          event: 'reservation:expired',
          data: { id: event.id, orderId: event.aggregateId },
        });
      }
      return messages;
    }
    default:
      return [];
  }
}
