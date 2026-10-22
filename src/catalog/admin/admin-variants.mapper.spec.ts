import { toAdminVariantRow } from './admin-variants.mapper';

const base = {
  id: 'v',
  sku: 'S-1',
  name: 'N',
  attributes: { ramGb: 16 },
  priceMinor: 100,
  isActive: true,
  product: { id: 'p', name: 'P', slug: 'p', isActive: false, brand: { name: 'Dell' } },
};

describe('toAdminVariantRow', () => {
  it('maps stock and product data', () => {
    const r = toAdminVariantRow({
      ...base,
      inventory: { onHand: 10, reserved: 3, reorderLevel: 5 },
    });
    expect([r.onHand, r.reserved, r.available, r.reorderLevel]).toEqual([10, 3, 7, 5]);
    expect([r.productId, r.productActive, r.brandName]).toEqual(['p', false, 'Dell']);
    expect(r.attributes).toEqual({ ramGb: 16 });
  });
  it('handles a missing inventory row and bad attributes', () => {
    const r = toAdminVariantRow({ ...base, attributes: [1], inventory: null });
    expect([r.onHand, r.available, r.reorderLevel]).toEqual([0, 0, 0]);
    expect(r.attributes).toEqual({});
    expect(toAdminVariantRow({ ...base, attributes: null, inventory: null }).attributes).toEqual(
      {},
    );
  });
});
