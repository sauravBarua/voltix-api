import { Prisma } from '../../src/generated/prisma/client';
import type { PrismaService } from '../../src/prisma/prisma.service';

export type StockViolation = {
  variantId: string;
  onHand: number;
  reserved: number;
  activeReserved: number;
  ledgerOnHand: number;
  ledgerReserved: number;
};

/** The three books-balance rules of the reconciliation job, scoped to some variants. Empty = consistent. */
export async function stockViolations(
  prisma: PrismaService,
  variantIds: string[],
): Promise<StockViolation[]> {
  if (variantIds.length === 0) return [];
  const ids = Prisma.join(variantIds.map((id) => Prisma.sql`${id}::uuid`));
  return prisma.$queryRaw<StockViolation[]>`
    SELECT i.variant_id AS "variantId", i.on_hand AS "onHand", i.reserved,
           COALESCE(r.q, 0)::int AS "activeReserved",
           COALESCE(m.o, 0)::int AS "ledgerOnHand",
           COALESCE(m.r, 0)::int AS "ledgerReserved"
    FROM inventory_items i
    LEFT JOIN (SELECT variant_id, SUM(quantity) AS q FROM stock_reservations WHERE status = 'ACTIVE' GROUP BY variant_id) r
           ON r.variant_id = i.variant_id
    LEFT JOIN (SELECT variant_id, SUM(delta_on_hand) AS o, SUM(delta_reserved) AS r FROM inventory_movements GROUP BY variant_id) m
           ON m.variant_id = i.variant_id
    WHERE i.variant_id IN (${ids})
      AND (i.reserved <> COALESCE(r.q, 0) OR i.on_hand <> COALESCE(m.o, 0) OR i.reserved <> COALESCE(m.r, 0))`;
}
