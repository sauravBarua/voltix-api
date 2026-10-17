import { BadRequestException } from '@nestjs/common';
import { computeShipping, generateOrderNumber, parseIdempotencyKey } from './orders.utils';

describe('generateOrderNumber', () => {
  const now = new Date('2026-10-17T12:00:00Z');

  it('uses the UTC date and the random bytes', () => {
    expect(generateOrderNumber(now, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]))).toBe(
      'VLX-20261017-01234567',
    );
    expect(generateOrderNumber(now, Buffer.alloc(8, 255))).toBe('VLX-20261017-ZZZZZZZZ');
  });

  it('generates well-formed, distinct numbers', () => {
    const a = generateOrderNumber();
    expect(a).toMatch(/^VLX-\d{8}-[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(generateOrderNumber()).not.toBe(a);
  });
});

describe('computeShipping', () => {
  it('is flat below the threshold and free from it', () => {
    expect(computeShipping(0)).toBe(990);
    expect(computeShipping(49_999)).toBe(990);
    expect(computeShipping(50_000)).toBe(0);
  });
});

describe('parseIdempotencyKey', () => {
  it('accepts and trims a valid key', () => {
    expect(parseIdempotencyKey('  order-key-123 ')).toBe('order-key-123');
  });

  it('rejects missing, short, long and unsafe keys', () => {
    expect(() => parseIdempotencyKey(undefined)).toThrow(BadRequestException);
    expect(() => parseIdempotencyKey('short')).toThrow(BadRequestException);
    expect(() => parseIdempotencyKey('x'.repeat(101))).toThrow(BadRequestException);
    expect(() => parseIdempotencyKey('has spaces in it')).toThrow(BadRequestException);
  });
});
