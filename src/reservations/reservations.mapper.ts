import type { Prisma } from '../generated/prisma/client';

export const reservationSelect = {
  id: true,
  orderId: true,
  variantId: true,
  quantity: true,
  status: true,
  expiresAt: true,
  resolvedAt: true,
  createdAt: true,
  variant: { select: { sku: true } },
} satisfies Prisma.StockReservationSelect;

export type ReservationRow = Prisma.StockReservationGetPayload<{
  select: typeof reservationSelect;
}>;

export function toReservationView(r: ReservationRow) {
  return {
    id: r.id,
    orderId: r.orderId,
    variantId: r.variantId,
    sku: r.variant.sku,
    quantity: r.quantity,
    status: r.status,
    expiresAt: r.expiresAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}
