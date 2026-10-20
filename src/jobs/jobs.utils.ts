import { createHash } from 'node:crypto';

export const daysAgo = (days: number, now = Date.now()) => new Date(now - days * 86_400_000);

export const randomBetween = (min: number, max: number) =>
  Math.round(min + Math.random() * (max - min));

/** Same mismatches in any order give the same fingerprint, so an unchanged problem alerts only once. */
export function mismatchFingerprint(
  rows: { variantId: string; onHand: number; reserved: number }[],
): string {
  const key = rows
    .map((r) => `${r.variantId}:${r.onHand}:${r.reserved}`)
    .sort()
    .join('|');
  return createHash('sha1').update(key).digest('hex');
}

/** A job is healthy while its last success is younger than three intervals (never ran = not healthy). */
export function isHealthy(
  lastSuccessAt: Date | null,
  intervalMs: number,
  now = Date.now(),
): boolean {
  return lastSuccessAt !== null && now - lastSuccessAt.getTime() <= intervalMs * 3;
}
