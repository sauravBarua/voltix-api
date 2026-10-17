import type { Prisma } from '../generated/prisma/client';

export const cartSelect = {
  id: true,
  items: {
    orderBy: { createdAt: 'asc' },
    select: {
      quantity: true,
      variant: {
        select: {
          id: true,
          sku: true,
          name: true,
          priceMinor: true,
          currency: true,
          isActive: true,
          inventory: { select: { onHand: true, reserved: true } },
          images: { orderBy: { position: 'asc' }, take: 1, select: { secureUrl: true } },
          product: {
            select: {
              name: true,
              slug: true,
              isActive: true,
              images: {
                where: { variantId: null },
                orderBy: [{ isPrimary: 'desc' }, { position: 'asc' }],
                take: 1,
                select: { secureUrl: true },
              },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.CartSelect;

export type CartRow = Prisma.CartGetPayload<{ select: typeof cartSelect }>;
export type LineStatus = 'OK' | 'INSUFFICIENT_STOCK' | 'UNAVAILABLE';

export function lineStatus(a: {
  variantActive: boolean;
  productActive: boolean;
  quantity: number;
  onHand: number;
  reserved: number;
}): LineStatus {
  if (!a.variantActive || !a.productActive) return 'UNAVAILABLE';
  return a.onHand - a.reserved >= a.quantity ? 'OK' : 'INSUFFICIENT_STOCK';
}

export function toCartView(cart: CartRow | null) {
  const items = (cart?.items ?? []).map((item) => {
    const v = item.variant;
    const onHand = v.inventory?.onHand ?? 0;
    const reserved = v.inventory?.reserved ?? 0;
    return {
      variantId: v.id,
      sku: v.sku,
      productName: v.product.name,
      productSlug: v.product.slug,
      variantName: v.name,
      imageUrl: v.images[0]?.secureUrl ?? v.product.images[0]?.secureUrl ?? null,
      unitPriceMinor: v.priceMinor,
      currency: v.currency,
      quantity: item.quantity,
      lineTotalMinor: v.priceMinor * item.quantity,
      available: Math.max(0, onHand - reserved),
      status: lineStatus({
        variantActive: v.isActive,
        productActive: v.product.isActive,
        quantity: item.quantity,
        onHand,
        reserved,
      }),
    };
  });

  return {
    id: cart?.id ?? null,
    items,
    itemCount: items.reduce((sum, i) => sum + i.quantity, 0),
    subtotalMinor: items
      .filter((i) => i.status !== 'UNAVAILABLE')
      .reduce((sum, i) => sum + i.lineTotalMinor, 0),
    currency: items[0]?.currency ?? 'EUR',
    hasIssues: items.some((i) => i.status !== 'OK'),
  };
}
