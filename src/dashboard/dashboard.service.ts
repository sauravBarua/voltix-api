import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ORDER_STATUSES } from '../orders/orders.dto';
import { CacheService } from '../redis/cache.service';
import { stableStringify } from '../redis/stable-stringify';
import { CURRENCY, TTL } from './dashboard.constants';
import type { Granularity } from './dashboard.dto';
import { DashboardQueries, type KpiRow } from './dashboard.queries';
import {
  type DashboardRange,
  averageOrderValue,
  previousRange,
  sharePercent,
} from './dashboard.utils';

const rangeView = (r: DashboardRange) => ({
  from: r.from.toISOString(),
  to: r.to.toISOString(),
  tz: r.tz,
});

function toKpi(row: KpiRow) {
  const revenueMinor = Number(row.revenue);
  const refundsMinor = Number(row.refunds);
  return {
    revenueMinor,
    refundsMinor,
    netRevenueMinor: revenueMinor - refundsMinor,
    orders: row.orders,
    averageOrderValueMinor: averageOrderValue(revenueMinor, row.orders),
    unitsSold: Number(row.units),
  };
}

/** Dashboard numbers are read-only views: cached with short TTLs, never used to decide anything. */
@Injectable()
export class DashboardService {
  constructor(
    private readonly cache: CacheService,
    private readonly queries: DashboardQueries,
  ) {}

  private cached<T>(
    name: string,
    params: unknown,
    ttl: number,
    loader: () => Promise<T>,
  ): Promise<T> {
    const hash = createHash('sha1').update(stableStringify(params)).digest('hex').slice(0, 20);
    return this.cache.getOrSet(`cache:dash:${name}:${hash}`, ttl, loader);
  }

  kpis(range: DashboardRange) {
    return this.cached('kpis', rangeView(range), TTL.kpis, async () => {
      const previous = previousRange(range);
      const [current, before] = await Promise.all([
        this.queries.kpis(range.from, range.to),
        this.queries.kpis(previous.from, previous.to),
      ]);
      return {
        range: rangeView(range),
        currency: CURRENCY,
        current: toKpi(current),
        previous: toKpi(before),
      };
    });
  }

  salesOverTime(range: DashboardRange, granularity: Granularity) {
    return this.cached('sales', { ...rangeView(range), granularity }, TTL.sales, async () => {
      const rows = await this.queries.salesOverTime(range.from, range.to, range.tz, granularity);
      return {
        range: rangeView(range),
        granularity,
        currency: CURRENCY,
        points: rows.map((r) => ({
          bucket: r.bucket,
          orders: r.orders,
          revenueMinor: Number(r.revenue),
          refundsMinor: Number(r.refunds),
          unitsSold: Number(r.units),
        })),
      };
    });
  }

  ordersByStatus(range: DashboardRange) {
    return this.cached('status', rangeView(range), TTL.ordersByStatus, async () => {
      const rows = await this.queries.ordersByStatus(range.from, range.to);
      const byStatus = ORDER_STATUSES.map((status) => {
        const row = rows.find((r) => r.status === status);
        return { status, count: row?.count ?? 0, totalMinor: Number(row?.total ?? 0) };
      });
      return {
        range: rangeView(range),
        total: byStatus.reduce((sum, s) => sum + s.count, 0),
        byStatus,
      };
    });
  }

  topProducts(
    range: DashboardRange,
    level: 'product' | 'variant',
    by: 'revenue' | 'units',
    limit: number,
  ) {
    return this.cached('top', { ...rangeView(range), level, by, limit }, TTL.top, async () => {
      const rows = await this.queries.topProducts(range.from, range.to, level, by, limit);
      return {
        range: rangeView(range),
        level,
        by,
        items: rows.map((r) => ({
          id: r.id,
          name: r.name,
          slug: r.slug ?? undefined,
          sku: r.sku ?? undefined,
          productName: r.productName ?? undefined,
          unitsSold: r.units,
          revenueMinor: Number(r.revenue),
          orders: r.orders,
        })),
      };
    });
  }

  breakdown(range: DashboardRange, group: 'category' | 'brand') {
    return this.cached('breakdown', { ...rangeView(range), group }, TTL.breakdown, async () => {
      const rows = await this.queries.breakdown(range.from, range.to, group);
      const total = rows.reduce((sum, r) => sum + Number(r.revenue), 0);
      return {
        range: rangeView(range),
        group,
        totalRevenueMinor: total,
        items: rows.map((r) => ({
          id: r.id,
          name: r.name,
          slug: r.slug ?? undefined,
          unitsSold: r.units,
          revenueMinor: Number(r.revenue),
          orders: r.orders,
          sharePercent: sharePercent(Number(r.revenue), total),
        })),
      };
    });
  }

  recentOrders(limit: number) {
    return this.cached('recent-orders', { limit }, TTL.recentOrders, async () => ({
      items: await this.queries.recentOrders(limit),
    }));
  }

  inventorySummary() {
    return this.cached('inv-summary', {}, TTL.inventorySummary, () =>
      this.queries.inventorySummary(),
    );
  }

  stockAlerts(kind: 'low' | 'out', limit: number, q?: string) {
    const load = async () => ({ items: await this.queries.stockAlerts(kind, limit, q) });
    // Free-text searches are not cached: their key space is unbounded
    return q ? load() : this.cached(`stock-${kind}`, { limit }, TTL.stockAlerts, load);
  }

  recentMovements(limit: number) {
    return this.cached('movements', { limit }, TTL.movements, async () => ({
      items: await this.queries.recentMovements(limit),
    }));
  }
}
