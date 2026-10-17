import { BadRequestException } from '@nestjs/common';

export type ReserveLine = { variantId: string; quantity: number };

/** Plain comparison (not localeCompare) so every process locks rows in the same order. */
export const byVariantId = (a: { variantId: string }, b: { variantId: string }) =>
  a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0;

/** Validates lines and sorts them by variantId (consistent lock order prevents deadlocks). */
export function normalizeLines(lines: ReserveLine[]): ReserveLine[] {
  if (lines.length === 0) throw new BadRequestException('At least one line is required');
  const seen = new Set<string>();
  for (const line of lines) {
    if (!Number.isInteger(line.quantity) || line.quantity < 1) {
      throw new BadRequestException('Quantity must be a positive integer');
    }
    if (seen.has(line.variantId))
      throw new BadRequestException('Duplicate variant in reservation lines');
    seen.add(line.variantId);
  }
  return [...lines].sort(byVariantId);
}
