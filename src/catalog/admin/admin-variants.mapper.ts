import { availableOf } from './admin-products.mapper';

type VariantRow = {
  id: string;
  sku: string;
  name: string;
  attributes: unknown;
  priceMinor: number;
  isActive: boolean;
  product: { id: string; name: string; slug: string; isActive: boolean; brand: { name: string } };
  inventory: { onHand: number; reserved: number; reorderLevel: number } | null;
};

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export function toAdminVariantRow(v: VariantRow) {
  return {
    id: v.id,
    sku: v.sku,
    name: v.name,
    attributes: asRecord(v.attributes),
    priceMinor: v.priceMinor,
    isActive: v.isActive,
    productId: v.product.id,
    productName: v.product.name,
    productSlug: v.product.slug,
    productActive: v.product.isActive,
    brandName: v.product.brand.name,
    onHand: v.inventory?.onHand ?? 0,
    reserved: v.inventory?.reserved ?? 0,
    available: availableOf(v.inventory),
    reorderLevel: v.inventory?.reorderLevel ?? 0,
  };
}
