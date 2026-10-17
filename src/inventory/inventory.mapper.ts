import type { Prisma } from '../generated/prisma/client';

export const movementSelect = {
  id: true,
  variantId: true,
  type: true,
  deltaOnHand: true,
  deltaReserved: true,
  reason: true,
  referenceType: true,
  referenceId: true,
  actorId: true,
  createdAt: true,
  variant: { select: { sku: true } },
} satisfies Prisma.InventoryMovementSelect;

export type MovementRow = Prisma.InventoryMovementGetPayload<{ select: typeof movementSelect }>;

export function mapMovement(m: MovementRow) {
  return {
    id: m.id,
    variantId: m.variantId,
    sku: m.variant.sku,
    type: m.type,
    deltaOnHand: m.deltaOnHand,
    deltaReserved: m.deltaReserved,
    reason: m.reason,
    referenceType: m.referenceType,
    referenceId: m.referenceId,
    actorId: m.actorId,
    createdAt: m.createdAt.toISOString(),
  };
}

export type StockRow = {
  variantId: string;
  onHand: number;
  reserved: number;
  reorderLevel: number;
};

export function toSnapshot(s: StockRow) {
  return {
    variantId: s.variantId,
    onHand: s.onHand,
    reserved: s.reserved,
    available: s.onHand - s.reserved,
    reorderLevel: s.reorderLevel,
  };
}

export type ItemInput = StockRow & {
  sku: string;
  variantName: string;
  productName: string;
  isActive: boolean;
  priceMinor: number;
};

export function toItem(i: ItemInput) {
  const stock = toSnapshot(i);
  return {
    ...stock,
    sku: i.sku,
    variantName: i.variantName,
    productName: i.productName,
    isActive: i.isActive,
    priceMinor: i.priceMinor,
    lowStock: stock.available <= i.reorderLevel,
  };
}
