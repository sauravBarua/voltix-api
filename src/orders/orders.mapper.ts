import type { Prisma } from '../generated/prisma/client';

export const orderSelect = {
  id: true,
  orderNumber: true,
  status: true,
  subtotalMinor: true,
  shippingMinor: true,
  totalMinor: true,
  currency: true,
  shippingAddress: true,
  cancelReason: true,
  paidAt: true,
  shippedAt: true,
  cancelledAt: true,
  createdAt: true,
  items: {
    orderBy: { skuSnapshot: 'asc' },
    select: {
      variantId: true,
      skuSnapshot: true,
      nameSnapshot: true,
      unitPriceMinor: true,
      quantity: true,
    },
  },
  reservations: { where: { status: 'ACTIVE' }, select: { expiresAt: true } },
} satisfies Prisma.OrderSelect;

export const adminOrderSelect = {
  ...orderSelect,
  user: { select: { id: true, email: true, name: true } },
} satisfies Prisma.OrderSelect;

export type OrderRow = Prisma.OrderGetPayload<{ select: typeof orderSelect }>;
export type AdminOrderRow = Prisma.OrderGetPayload<{ select: typeof adminOrderSelect }>;

export function toOrderView(o: OrderRow) {
  const expiries = o.reservations.map((r) => r.expiresAt.getTime());
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    status: o.status,
    items: o.items.map((i) => ({
      variantId: i.variantId,
      sku: i.skuSnapshot,
      name: i.nameSnapshot,
      unitPriceMinor: i.unitPriceMinor,
      quantity: i.quantity,
      lineTotalMinor: i.unitPriceMinor * i.quantity,
    })),
    subtotalMinor: o.subtotalMinor,
    shippingMinor: o.shippingMinor,
    totalMinor: o.totalMinor,
    currency: o.currency,
    shippingAddress: o.shippingAddress,
    expiresAt:
      o.status === 'PENDING_PAYMENT' && expiries.length
        ? new Date(Math.min(...expiries)).toISOString()
        : null,
    cancelReason: o.cancelReason,
    paidAt: o.paidAt?.toISOString() ?? null,
    shippedAt: o.shippedAt?.toISOString() ?? null,
    cancelledAt: o.cancelledAt?.toISOString() ?? null,
    createdAt: o.createdAt.toISOString(),
  };
}

export function toAdminOrderView(o: AdminOrderRow) {
  return { ...toOrderView(o), customer: o.user };
}
