import type { Prisma } from '../../generated/prisma/client';

export const variantSelect = {
  id: true,
  sku: true,
  name: true,
  attributes: true,
  priceMinor: true,
  currency: true,
  isActive: true,
  inventory: { select: { onHand: true, reserved: true } },
} satisfies Prisma.ProductVariantSelect;

export function productInclude(variantWhere: Prisma.ProductVariantWhereInput) {
  return {
    brand: { select: { id: true, name: true, slug: true } },
    category: { select: { id: true, name: true, slug: true } },
    images: {
      orderBy: { position: 'asc' },
      select: { id: true, secureUrl: true, isPrimary: true, variantId: true },
    },
    variants: { where: variantWhere, orderBy: { priceMinor: 'asc' }, select: variantSelect },
  } satisfies Prisma.ProductInclude;
}

export type ProductRow = Prisma.ProductGetPayload<{ include: ReturnType<typeof productInclude> }>;
export type VariantRow = Prisma.ProductVariantGetPayload<{ select: typeof variantSelect }>;

export function mapVariant(v: VariantRow) {
  return {
    id: v.id,
    sku: v.sku,
    name: v.name,
    attributes: v.attributes,
    priceMinor: v.priceMinor,
    currency: v.currency,
    isActive: v.isActive,
    available: v.inventory ? Math.max(0, v.inventory.onHand - v.inventory.reserved) : 0,
  };
}

export function mapProductSummary(p: ProductRow) {
  const variants = p.variants.map(mapVariant); // already sorted by price asc
  const primary = p.images.find((i) => i.isPrimary) ?? p.images[0];
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    brand: p.brand,
    category: p.category,
    imageUrl: primary?.secureUrl ?? null,
    priceFromMinor: variants.length ? variants[0].priceMinor : null,
    currency: variants.length ? variants[0].currency : null,
    inStock: variants.some((v) => v.available > 0),
  };
}

export function mapProductDetail(p: ProductRow) {
  return {
    ...mapProductSummary(p),
    description: p.description,
    specs: p.specs,
    warrantyMonths: p.warrantyMonths,
    images: p.images.map((i) => ({
      id: i.id,
      url: i.secureUrl,
      isPrimary: i.isPrimary,
      variantId: i.variantId,
    })),
    variants: p.variants.map(mapVariant),
  };
}

/** Public read shape WITHOUT stock: cacheable. Availability is overlaid per request (CatalogCacheService). */
export function mapProductStatic(p: ProductRow) {
  const s = mapProductSummary(p);
  return {
    id: s.id,
    name: s.name,
    slug: s.slug,
    brand: s.brand,
    category: s.category,
    imageUrl: s.imageUrl,
    priceFromMinor: s.priceFromMinor,
    currency: s.currency,
    variantIds: p.variants.map((v) => v.id),
  };
}

export function mapProductDetailStatic(p: ProductRow) {
  const d = mapProductDetail(p);
  return {
    ...mapProductStatic(p),
    description: d.description,
    specs: d.specs,
    warrantyMonths: d.warrantyMonths,
    images: d.images,
    variants: p.variants.map((v) => {
      const m = mapVariant(v);
      return {
        id: m.id,
        sku: m.sku,
        name: m.name,
        attributes: m.attributes,
        priceMinor: m.priceMinor,
        currency: m.currency,
        isActive: m.isActive,
      };
    }),
  };
}
