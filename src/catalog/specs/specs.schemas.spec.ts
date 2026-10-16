import { getSpecsSchema } from './specs.schemas';

const laptop = { cpu: 'Apple M3', screenSizeInch: 13.6, os: 'macOS' };

describe('getSpecsSchema', () => {
  it('accepts valid laptop specs', () => {
    expect(getSpecsSchema('laptops').safeParse(laptop).success).toBe(true);
  });

  it('rejects missing required fields', () => {
    expect(getSpecsSchema('laptops').safeParse({ cpu: 'x' }).success).toBe(false);
  });

  it('rejects unknown keys on laptops', () => {
    expect(getSpecsSchema('laptops').safeParse({ ...laptop, foo: 1 }).success).toBe(false);
  });

  it('falls back to the parent category schema', () => {
    expect(getSpecsSchema('gaming-laptops', 'laptops').safeParse({ cpu: 'x' }).success).toBe(false);
  });

  it('requires a type for accessories but allows extra keys', () => {
    expect(getSpecsSchema('accessories').safeParse({ powerW: 65 }).success).toBe(false);
    expect(getSpecsSchema('accessories').safeParse({ type: 'charger', powerW: 65 }).success).toBe(
      true,
    );
  });

  it('accepts any object for unknown categories', () => {
    expect(getSpecsSchema('misc').safeParse({ a: 1 }).success).toBe(true);
  });
});
