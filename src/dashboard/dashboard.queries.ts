import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { mapMovement, movementSelect } from '../inventory/inventory.mapper';
import { escapeLike } from '../inventory/inventory.utils';
import { PrismaService } from '../prisma/prisma.service';
import type { Granularity } from './dashboard.dto';

const iso = (d: Date) => d.toISOString();

// Per-order sums as LATERAL joins: each order is counted once even though it has many lines and payments.
// Money is summed as bigint and returned as float8: exact up to 2^53 minor units, and JSON-safe (bigint is not).
const REFUNDS_JOIN = Prisma.sql`LEFT JOIN LATERAL (SELECT COALESCE(SUM(refunded_minor), 0)::bigint AS r FROM payments WHERE order_id = o.id) pr ON true`;
const UNITS_JOIN = Prisma.sql`LEFT JOIN LATERAL (SELECT COALESCE(SUM(quantity), 0)::bigint AS u FROM order_items WHERE order_id = o.id) it ON true`;

// Only variants that had stock at some point: same rule as the low-stock alert job
const EVER_STOCKED = Prisma.sql`EXISTS (SELECT 1 FROM inventory_movements m WHERE m.variant_id = i.variant_id AND m.delta_on_hand > 0)`;

export type KpiRow = { orders: number; revenue: number; refunds: number; units: number };
export type SalesRow = {
  bucket: string;
  orders: number;
  revenue: number;
  refunds: number;
  units: number;
};
export type StatusRow = { status: string; count: number; total: number };
export type TopRow = {
  id: string;
  name: string;
  slug: string | null;
  sku: string | null;
  productName: string | null;
  units: number;
  revenue: number;
  orders: number;
};
export type StockRow = {
  variantId: string;
  sku: string;
  productName: string;
  variantName: string;
  onHand: number;
  reserved: number;
  available: number;
  reorderLevel: number;
};

@Injectable()
export class DashboardQueries {
  constructor(private readonly prisma: PrismaService) {}

  async kpis(from: Date, to: Date): Promise<KpiRow> {
    const [row] = await this.prisma.$queryRaw<KpiRow[]>`
      SELECT COUNT(*)::int AS orders,
             COALESCE(SUM(o.total_minor), 0)::float8 AS revenue,
             COALESCE(SUM(pr.r), 0)::float8 AS refunds,
             COALESCE(SUM(it.u), 0)::float8 AS units
      FROM orders o ${REFUNDS_JOIN} ${UNITS_JOIN}
      WHERE o.paid_at >= ${iso(from)}::timestamptz AND o.paid_at < ${iso(to)}::timestamptz`;
    return row;
  }

  /** Buckets are generated in SQL (local time of `tz`), so empty days, weeks and months are zeros, not gaps. */
  salesOverTime(from: Date, to: Date, tz: string, unit: Granularity) {
    // `unit` is a validated enum, never user text, so it is safe to inline as a literal
    const u = Prisma.raw(`'${unit}'`);
    const step = Prisma.raw(`interval '1 ${unit}'`);
    return this.prisma.$queryRaw<SalesRow[]>`
      WITH buckets AS (
        SELECT generate_series(
          date_trunc(${u}, ${iso(from)}::timestamptz AT TIME ZONE ${tz}::text),
          date_trunc(${u}, (${iso(to)}::timestamptz - interval '1 millisecond') AT TIME ZONE ${tz}::text),
          ${step}) AS bucket
      ), sales AS (
        SELECT date_trunc(${u}, o.paid_at AT TIME ZONE ${tz}::text) AS bucket,
               COUNT(*)::int AS orders,
               SUM(o.total_minor)::float8 AS revenue,
               SUM(pr.r)::float8 AS refunds,
               SUM(it.u)::float8 AS units
        FROM orders o ${REFUNDS_JOIN} ${UNITS_JOIN}
        WHERE o.paid_at >= ${iso(from)}::timestamptz AND o.paid_at < ${iso(to)}::timestamptz
        GROUP BY 1
      )
      SELECT to_char(b.bucket, 'YYYY-MM-DD') AS bucket,
             COALESCE(s.orders, 0)::int AS orders,
             COALESCE(s.revenue, 0)::float8 AS revenue,
             COALESCE(s.refunds, 0)::float8 AS refunds,
             COALESCE(s.units, 0)::float8 AS units
      FROM buckets b LEFT JOIN sales s ON s.bucket = b.bucket
      ORDER BY b.bucket`;
  }

  ordersByStatus(from: Date, to: Date) {
    return this.prisma.$queryRaw<StatusRow[]>`
      SELECT status::text AS status, COUNT(*)::int AS count, COALESCE(SUM(total_minor), 0)::float8 AS total
      FROM orders
      WHERE created_at >= ${iso(from)}::timestamptz AND created_at < ${iso(to)}::timestamptz
      GROUP BY status`;
  }

  topProducts(
    from: Date,
    to: Date,
    level: 'product' | 'variant',
    by: 'revenue' | 'units',
    limit: number,
  ) {
    const order =
      by === 'units' ? Prisma.sql`units DESC, revenue DESC` : Prisma.sql`revenue DESC, units DESC`;
    const lines = Prisma.sql`
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN product_variants v ON v.id = oi.variant_id
      JOIN products p ON p.id = v.product_id
      WHERE o.paid_at >= ${iso(from)}::timestamptz AND o.paid_at < ${iso(to)}::timestamptz`;
    const sums = Prisma.sql`SUM(oi.quantity)::int AS units, SUM(oi.unit_price_minor::bigint * oi.quantity)::float8 AS revenue, COUNT(DISTINCT o.id)::int AS orders`;

    if (level === 'variant') {
      return this.prisma.$queryRaw<TopRow[]>`
        SELECT v.id::text AS id, v.name AS name, v.sku, p.name AS "productName", p.slug, ${sums}
        ${lines} GROUP BY v.id, p.id ORDER BY ${order}, v.id LIMIT ${limit}::int`;
    }
    return this.prisma.$queryRaw<TopRow[]>`
      SELECT p.id::text AS id, p.name AS name, NULL::text AS sku, NULL::text AS "productName", p.slug, ${sums}
      ${lines} GROUP BY p.id ORDER BY ${order}, p.id LIMIT ${limit}::int`;
  }

  breakdown(from: Date, to: Date, group: 'category' | 'brand') {
    const table = group === 'category' ? Prisma.sql`categories` : Prisma.sql`brands`;
    const fk = group === 'category' ? Prisma.sql`p.category_id` : Prisma.sql`p.brand_id`;
    return this.prisma.$queryRaw<TopRow[]>`
      SELECT g.id::text AS id, g.name AS name, g.slug, NULL::text AS sku, NULL::text AS "productName",
             SUM(oi.quantity)::int AS units,
             SUM(oi.unit_price_minor::bigint * oi.quantity)::float8 AS revenue,
             COUNT(DISTINCT o.id)::int AS orders
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN product_variants v ON v.id = oi.variant_id
      JOIN products p ON p.id = v.product_id
      JOIN ${table} g ON g.id = ${fk}
      WHERE o.paid_at >= ${iso(from)}::timestamptz AND o.paid_at < ${iso(to)}::timestamptz
      GROUP BY g.id ORDER BY revenue DESC, g.id LIMIT 50`;
  }

  async recentOrders(limit: number) {
    const rows = await this.prisma.order.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: {
        id: true,
        orderNumber: true,
        status: true,
        totalMinor: true,
        currency: true,
        createdAt: true,
        paidAt: true,
        user: { select: { name: true, email: true } },
        items: { select: { quantity: true } },
      },
    });
    return rows.map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      status: o.status,
      totalMinor: o.totalMinor,
      currency: o.currency,
      itemCount: o.items.reduce((sum, i) => sum + i.quantity, 0),
      createdAt: o.createdAt.toISOString(),
      paidAt: o.paidAt?.toISOString() ?? null,
      customer: o.user,
    }));
  }

  /** One row per paid order, no personal data. Fetches one row more than the cap so the caller can detect overflow. */
  exportOrders(from: Date, to: Date, cap: number) {
    return this.prisma.$queryRaw<
      {
        orderNumber: string;
        paidAt: Date;
        status: string;
        subtotal: number;
        shipping: number;
        total: number;
        refunded: number;
        units: number;
        currency: string;
      }[]
    >`
      SELECT o.order_number AS "orderNumber", o.paid_at AS "paidAt", o.status::text AS status,
             o.subtotal_minor AS subtotal, o.shipping_minor AS shipping, o.total_minor AS total,
             COALESCE(pr.r, 0)::float8 AS refunded, COALESCE(it.u, 0)::float8 AS units, o.currency
      FROM orders o ${REFUNDS_JOIN} ${UNITS_JOIN}
      WHERE o.paid_at >= ${iso(from)}::timestamptz AND o.paid_at < ${iso(to)}::timestamptz
      ORDER BY o.paid_at, o.id
      LIMIT ${cap + 1}::int`;
  }

  // ── inventory ──

  async inventorySummary() {
    const [[counts], [value], [reservations]] = await Promise.all([
      this.prisma.$queryRaw<{ lowStock: number; outOfStock: number }[]>`
        SELECT COUNT(*) FILTER (WHERE i.on_hand - i.reserved <= i.reorder_level)::int AS "lowStock",
               COUNT(*) FILTER (WHERE i.on_hand - i.reserved <= 0)::int AS "outOfStock"
        FROM inventory_items i
        JOIN product_variants v ON v.id = i.variant_id
        JOIN products p ON p.id = v.product_id
        WHERE v.is_active AND p.is_active AND ${EVER_STOCKED}`,
      this.prisma.$queryRaw<{ value: number; units: number }[]>`
        SELECT COALESCE(SUM(i.on_hand::bigint * v.price_minor), 0)::float8 AS value,
               COALESCE(SUM(i.on_hand), 0)::float8 AS units
        FROM inventory_items i JOIN product_variants v ON v.id = i.variant_id`,
      this.prisma.$queryRaw<{ count: number; units: number }[]>`
        SELECT COUNT(*)::int AS count, COALESCE(SUM(quantity), 0)::int AS units
        FROM stock_reservations WHERE status = 'ACTIVE'`,
    ]);
    return {
      lowStockCount: counts.lowStock,
      outOfStockCount: counts.outOfStock,
      totalStockValueMinor: Number(value.value),
      totalUnitsOnHand: Number(value.units),
      activeReservations: reservations.count,
      reservedUnits: reservations.units,
    };
  }

  stockAlerts(kind: 'low' | 'out', limit: number, q?: string) {
    const condition =
      kind === 'out'
        ? Prisma.sql`i.on_hand - i.reserved <= 0`
        : Prisma.sql`i.on_hand - i.reserved <= i.reorder_level`;
    const like = q ? `%${escapeLike(q)}%` : null;
    const search = like
      ? Prisma.sql`AND (v.sku ILIKE ${like} OR v.name ILIKE ${like} OR p.name ILIKE ${like})`
      : Prisma.empty;
    return this.prisma.$queryRaw<StockRow[]>`
      SELECT v.id AS "variantId", v.sku, p.name AS "productName", v.name AS "variantName",
             i.on_hand AS "onHand", i.reserved, i.on_hand - i.reserved AS available, i.reorder_level AS "reorderLevel"
      FROM inventory_items i
      JOIN product_variants v ON v.id = i.variant_id
      JOIN products p ON p.id = v.product_id
      WHERE v.is_active AND p.is_active AND ${condition} AND ${EVER_STOCKED} ${search}
      ORDER BY available ASC, v.sku ASC
      LIMIT ${limit}::int`;
  }

  async recentMovements(limit: number) {
    const rows = await this.prisma.inventoryMovement.findMany({
      select: movementSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.map(mapMovement);
  }
}
