import { lineStatus } from './cart.mapper';

const base = { variantActive: true, productActive: true, quantity: 2, onHand: 5, reserved: 3 };

describe('lineStatus', () => {
  it('is OK when available covers the quantity', () => {
    expect(lineStatus(base)).toBe('OK');
  });

  it('is INSUFFICIENT_STOCK when reservations eat the stock', () => {
    expect(lineStatus({ ...base, reserved: 4 })).toBe('INSUFFICIENT_STOCK');
  });

  it('is UNAVAILABLE when the variant or the product is inactive', () => {
    expect(lineStatus({ ...base, variantActive: false })).toBe('UNAVAILABLE');
    expect(lineStatus({ ...base, productActive: false })).toBe('UNAVAILABLE');
  });
});
