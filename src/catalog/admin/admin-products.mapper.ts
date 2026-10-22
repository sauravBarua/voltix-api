type InventoryRow = { onHand: number; reserved: number } | null;
type VariantRow = { isActive: boolean; priceMinor: number; inventory: InventoryRow };

/** Units that can still be sold: on hand minus reserved, never negative. */
export const availableOf = (inventory: InventoryRow): number =>
  inventory ? Math.max(inventory.onHand - inventory.reserved, 0) : 0;

/** Row figures for the admin list. Inactive variants count in variantCount only. */
export function summarizeVariants(variants: VariantRow[]) {
  const active = variants.filter((v) => v.isActive);
  const prices = active.map((v) => v.priceMinor);
  return {
    variantCount: variants.length,
    activeVariantCount: active.length,
    priceFromMinor: prices.length ? Math.min(...prices) : null,
    priceToMinor: prices.length ? Math.max(...prices) : null,
    available: active.reduce((sum, v) => sum + availableOf(v.inventory), 0),
  };
}
