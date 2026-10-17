import { stableStringify } from './stable-stringify';

describe('stableStringify', () => {
  it('ignores key order and undefined values', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: undefined } })).toBe(
      stableStringify({ a: { d: 2 }, b: 1 }),
    );
  });

  it('keeps array order and tells different values apart', () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
    expect(stableStringify({ page: 1 })).not.toBe(stableStringify({ page: 2 }));
  });

  it('handles primitives and null', () => {
    expect(stableStringify('x')).toBe('"x"');
    expect(stableStringify(null)).toBe('null');
  });
});
