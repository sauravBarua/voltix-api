import { randomBytes } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { FLAT_SHIPPING_MINOR, FREE_SHIPPING_THRESHOLD_MINOR } from './orders.constants';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: 32 symbols, no I L O U

/** VLX-YYYYMMDD-XXXXXXXX (8 random symbols, ~10^12 combinations per day). */
export function generateOrderNumber(now = new Date(), bytes: Buffer = randomBytes(8)): string {
  const date = now.toISOString().slice(0, 10).replaceAll('-', '');
  let suffix = '';
  for (const byte of bytes) suffix += ALPHABET[byte & 31];
  return `VLX-${date}-${suffix}`;
}

export function computeShipping(subtotalMinor: number): number {
  return subtotalMinor >= FREE_SHIPPING_THRESHOLD_MINOR ? 0 : FLAT_SHIPPING_MINOR;
}

export function parseIdempotencyKey(raw: string | undefined): string {
  const key = raw?.trim();
  if (!key || key.length < 8 || key.length > 100 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw new BadRequestException(
      'Idempotency-Key header is required (8-100 characters: letters, digits, . _ : -)',
    );
  }
  return key;
}
