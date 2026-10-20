import { BadRequestException } from '@nestjs/common';
import { DEFAULT_RANGE_DAYS, DEFAULT_TIME_ZONE, MAX_RANGE_DAYS } from './dashboard.constants';

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

export type DashboardRange = { from: Date; to: Date; tz: string };

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Rounded up to the next full minute, so the default range (and its cache key) is stable for a minute. */
export const ceilToMinute = (d: Date) => new Date(Math.ceil(d.getTime() / MINUTE_MS) * MINUTE_MS);

/** [from, to): defaults to the last 30 days ending now. */
export function resolveRange(
  q: { from?: string; to?: string; tz?: string },
  now = new Date(),
): DashboardRange {
  const tz = q.tz ?? DEFAULT_TIME_ZONE;
  const to = q.to ? new Date(q.to) : ceilToMinute(now);
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - DEFAULT_RANGE_DAYS * DAY_MS);
  if (!(from.getTime() < to.getTime())) throw new BadRequestException('from must be before to');
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) {
    throw new BadRequestException(`The range cannot exceed ${MAX_RANGE_DAYS} days`);
  }
  return { from, to, tz };
}

/** The period of the same length that ends where this one starts. */
export function previousRange(range: DashboardRange): DashboardRange {
  const span = range.to.getTime() - range.from.getTime();
  return { from: new Date(range.from.getTime() - span), to: range.from, tz: range.tz };
}

export const averageOrderValue = (revenueMinor: number, orders: number) =>
  orders === 0 ? 0 : Math.round(revenueMinor / orders);

export const sharePercent = (part: number, total: number) =>
  total === 0 ? 0 : Math.round((part / total) * 1000) / 10;

export type CsvCell = string | number | null;

/** RFC 4180 CSV. Strings that a spreadsheet could read as a formula get a leading apostrophe. */
export function toCsv(headers: string[], rows: CsvCell[][]): string {
  const cell = (value: CsvCell): string => {
    if (value === null) return '';
    if (typeof value === 'number') return String(value);
    const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
  };
  return `${[headers, ...rows].map((row) => row.map(cell).join(',')).join('\r\n')}\r\n`;
}
