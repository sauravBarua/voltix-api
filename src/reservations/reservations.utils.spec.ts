import { BadRequestException } from '@nestjs/common';
import { normalizeLines } from './reservations.utils';

describe('normalizeLines', () => {
  it('sorts lines by variantId', () => {
    const result = normalizeLines([
      { variantId: 'b', quantity: 1 },
      { variantId: 'a', quantity: 2 },
    ]);
    expect(result.map((l) => l.variantId)).toEqual(['a', 'b']);
  });

  it('rejects empty input, bad quantities and duplicates', () => {
    expect(() => normalizeLines([])).toThrow(BadRequestException);
    expect(() => normalizeLines([{ variantId: 'a', quantity: 0 }])).toThrow(BadRequestException);
    expect(() => normalizeLines([{ variantId: 'a', quantity: 1.5 }])).toThrow(BadRequestException);
    expect(() =>
      normalizeLines([
        { variantId: 'a', quantity: 1 },
        { variantId: 'a', quantity: 2 },
      ]),
    ).toThrow(BadRequestException);
  });
});
