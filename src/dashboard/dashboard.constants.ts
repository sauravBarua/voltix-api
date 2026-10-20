export const DEFAULT_TIME_ZONE = 'Europe/Paris';
export const DEFAULT_RANGE_DAYS = 30;
export const MAX_RANGE_DAYS = 366;
export const CURRENCY = 'EUR'; // single currency (Phase 1 decision)
export const EXPORT_MAX_ROWS = 10_000;

/** Seconds. Short on purpose: these numbers are read-only views and never the authority. */
export const TTL = {
  kpis: 60,
  sales: 60,
  ordersByStatus: 15,
  top: 120,
  breakdown: 120,
  recentOrders: 5,
  inventorySummary: 10,
  stockAlerts: 10,
  movements: 5,
} as const;
