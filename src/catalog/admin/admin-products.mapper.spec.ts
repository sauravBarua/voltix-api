import { availableOf, summarizeVariants } from './admin-products.mapper';

describe('admin products mapper', () => {
  it('availableOf never goes negative', () => {
    expect(availableOf(null)).toBe(0);
    expect(availableOf({ onHand: 24, reserved: 3 })).toBe(21);
    expect(availableOf({ onHand: 1, reserved: 3 })).toBe(0);
  });

  it('summarizeVariants ignores inactive variants for price and stock', () => {
    expect(summarizeVariants([])).toEqual({
      variantCount: 0,
      activeVariantCount: 0,
      priceFromMinor: null,
      priceToMinor: null,
      available: 0,
    });
    expect(
      summarizeVariants([
        { isActive: true, priceMinor: 109900, inventory: { onHand: 24, reserved: 3 } },
        { isActive: true, priceMinor: 149900, inventory: null },
        { isActive: false, priceMinor: 9900, inventory: { onHand: 50, reserved: 0 } },
      ]),
    ).toEqual({
      variantCount: 3,
      activeVariantCount: 2,
      priceFromMinor: 109900,
      priceToMinor: 149900,
      available: 21,
    });
  });
});
