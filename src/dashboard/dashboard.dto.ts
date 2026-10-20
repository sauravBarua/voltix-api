import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ORDER_STATUSES } from '../orders/orders.dto';
import { isValidTimeZone } from './dashboard.utils';

export const GRANULARITIES = ['day', 'week', 'month'] as const;
export type Granularity = (typeof GRANULARITIES)[number];

// Refinements go on the finished object (Zod 4 does not allow extending a refined object)
const dateTime = z.iso.datetime({ offset: true });
const rangeShape = {
  from: dateTime.optional().describe('Inclusive. Default: 30 days before `to`'),
  to: dateTime.optional().describe('Exclusive. Default: now'),
  tz: z
    .string()
    .min(1)
    .max(64)
    .refine(isValidTimeZone, 'invalid IANA time zone')
    .optional()
    .describe('Bucket time zone, default Europe/Paris'),
};
const ordered = (q: { from?: string; to?: string }) =>
  !q.from || !q.to || new Date(q.from) < new Date(q.to);
const orderedError = { message: 'from must be before to', path: ['to'] };
const limit = z.coerce.number().int().min(1).max(50).default(10);

export class RangeQueryDto extends createZodDto(
  z.object(rangeShape).refine(ordered, orderedError),
) {}
export class SalesQueryDto extends createZodDto(
  z
    .object({ ...rangeShape, granularity: z.enum(GRANULARITIES).default('day') })
    .refine(ordered, orderedError),
) {}
export class TopProductsQueryDto extends createZodDto(
  z
    .object({
      ...rangeShape,
      level: z.enum(['product', 'variant']).default('product'),
      by: z.enum(['revenue', 'units']).default('revenue'),
      limit,
    })
    .refine(ordered, orderedError),
) {}
export class BreakdownQueryDto extends createZodDto(
  z
    .object({ ...rangeShape, group: z.enum(['category', 'brand']).default('category') })
    .refine(ordered, orderedError),
) {}
export class LimitQueryDto extends createZodDto(z.object({ limit })) {}
export class StockListQueryDto extends createZodDto(
  z.object({
    limit,
    q: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe('SKU, variant or product name (not cached)'),
  }),
) {}

// ── responses (documentation only; the data is plain JSON) ──
const range = z.object({ from: z.string(), to: z.string(), tz: z.string() });
const int = z.number().int();
const kpi = z.object({
  revenueMinor: int.describe('Gross, shipping included, of orders paid in the range'),
  refundsMinor: int.describe('Refunded amount of those orders'),
  netRevenueMinor: int,
  orders: int,
  averageOrderValueMinor: int,
  unitsSold: int,
});
const item = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string().optional(),
  sku: z.string().optional(),
  productName: z.string().optional(),
  unitsSold: int,
  revenueMinor: int,
  orders: int,
  sharePercent: z.number().optional(),
});

export class KpisDto extends createZodDto(
  z.object({ range, currency: z.string(), current: kpi, previous: kpi }),
) {}
export class SalesOverTimeDto extends createZodDto(
  z.object({
    range,
    granularity: z.enum(GRANULARITIES),
    currency: z.string(),
    points: z.array(
      z.object({
        bucket: z.string().describe('Local date of the bucket start, YYYY-MM-DD'),
        orders: int,
        revenueMinor: int,
        refundsMinor: int,
        unitsSold: int,
      }),
    ),
  }),
) {}
export class OrdersByStatusDto extends createZodDto(
  z.object({
    range,
    total: int,
    byStatus: z.array(z.object({ status: z.enum(ORDER_STATUSES), count: int, totalMinor: int })),
  }),
) {}
export class TopProductsDto extends createZodDto(
  z.object({ range, level: z.string(), by: z.string(), items: z.array(item) }),
) {}
export class BreakdownDto extends createZodDto(
  z.object({ range, group: z.string(), totalRevenueMinor: int, items: z.array(item) }),
) {}
export class RecentOrdersDto extends createZodDto(
  z.object({
    items: z.array(
      z.object({
        id: z.string(),
        orderNumber: z.string(),
        status: z.string(),
        totalMinor: int,
        currency: z.string(),
        itemCount: int,
        createdAt: z.string(),
        paidAt: z.string().nullable(),
        customer: z.object({ name: z.string(), email: z.string() }),
      }),
    ),
  }),
) {}
export class InventorySummaryDto extends createZodDto(
  z.object({
    lowStockCount: int.describe('available <= reorder level (includes out of stock)'),
    outOfStockCount: int,
    totalStockValueMinor: int.describe('on hand x current price, all variants'),
    totalUnitsOnHand: int,
    activeReservations: int,
    reservedUnits: int,
  }),
) {}
export class StockAlertsDto extends createZodDto(
  z.object({
    items: z.array(
      z.object({
        variantId: z.string(),
        sku: z.string(),
        productName: z.string(),
        variantName: z.string(),
        onHand: int,
        reserved: int,
        available: int,
        reorderLevel: int,
      }),
    ),
  }),
) {}
export class MovementsDto extends createZodDto(
  z.object({
    items: z.array(
      z.object({
        id: z.string(),
        variantId: z.string(),
        sku: z.string(),
        type: z.string(),
        deltaOnHand: int,
        deltaReserved: int,
        reason: z.string().nullable(),
        createdAt: z.string(),
      }),
    ),
  }),
) {}
