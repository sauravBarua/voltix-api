import { BadRequestException, Controller, Get, Header, Query, Req } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { Roles } from '../auth/access.decorators';
import type { AuthUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { EXPORT_MAX_ROWS } from './dashboard.constants';
import {
  BreakdownDto,
  BreakdownQueryDto,
  KpisDto,
  LimitQueryDto,
  OrdersByStatusDto,
  RangeQueryDto,
  RecentOrdersDto,
  SalesOverTimeDto,
  SalesQueryDto,
  TopProductsDto,
  TopProductsQueryDto,
} from './dashboard.dto';
import { DashboardQueries } from './dashboard.queries';
import { DashboardService } from './dashboard.service';
import { resolveRange, toCsv } from './dashboard.utils';

/** Money widgets: administrators only. All numbers are read-only views (cached, never the stock authority). */
@ApiTags('Admin dashboard')
@Roles('ADMIN')
@ApiBadRequestResponse({ description: 'Invalid range, time zone or filter' })
@Controller('admin/dashboard')
export class DashboardController {
  constructor(
    private readonly service: DashboardService,
    private readonly queries: DashboardQueries,
    private readonly audit: AuditService,
  ) {}

  @Get('kpis')
  @ApiOperation({
    summary:
      'Revenue, refunds, orders, average order value and units for the range, plus the previous period',
  })
  @ApiOkResponse({ type: KpisDto })
  kpis(@Query() q: RangeQueryDto) {
    return this.service.kpis(resolveRange(q));
  }

  @Get('sales-over-time')
  @ApiOperation({ summary: 'Sales per day, week (Monday start) or month, empty buckets included' })
  @ApiOkResponse({ type: SalesOverTimeDto })
  sales(@Query() q: SalesQueryDto) {
    return this.service.salesOverTime(resolveRange(q), q.granularity);
  }

  @Get('orders-by-status')
  @ApiOperation({ summary: 'Orders CREATED in the range, per status (all statuses listed)' })
  @ApiOkResponse({ type: OrdersByStatusDto })
  ordersByStatus(@Query() q: RangeQueryDto) {
    return this.service.ordersByStatus(resolveRange(q));
  }

  @Get('top-products')
  @ApiOperation({ summary: 'Best sellers by revenue or units, per product or per variant' })
  @ApiOkResponse({ type: TopProductsDto })
  top(@Query() q: TopProductsQueryDto) {
    return this.service.topProducts(resolveRange(q), q.level, q.by, q.limit);
  }

  @Get('sales-breakdown')
  @ApiOperation({ summary: 'Line revenue by category or by brand, with each share' })
  @ApiOkResponse({ type: BreakdownDto })
  breakdown(@Query() q: BreakdownQueryDto) {
    return this.service.breakdown(resolveRange(q), q.group);
  }

  @Get('recent-orders')
  @ApiOperation({ summary: 'Newest orders with their customer' })
  @ApiOkResponse({ type: RecentOrdersDto })
  recentOrders(@Query() q: LimitQueryDto) {
    return this.service.recentOrders(q.limit);
  }

  @Get('export/sales.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="sales.csv"')
  @ApiProduces('text/csv')
  @ApiOperation({
    summary: 'CSV of sales over time (same buckets as the chart). Recorded in the audit log.',
  })
  async exportSales(@Query() q: SalesQueryDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const range = resolveRange(q);
    const data = await this.service.salesOverTime(range, q.granularity);
    await this.recordExport(user, req, 'sales', range);
    return toCsv(
      ['bucket', 'orders', 'revenueMinor', 'refundsMinor', 'unitsSold'],
      data.points.map((p) => [p.bucket, p.orders, p.revenueMinor, p.refundsMinor, p.unitsSold]),
    );
  }

  @Get('export/orders.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="orders.csv"')
  @ApiProduces('text/csv')
  @ApiOperation({
    summary: `CSV with one row per paid order (no personal data, max ${EXPORT_MAX_ROWS} rows). Recorded in the audit log.`,
  })
  async exportOrders(
    @Query() q: RangeQueryDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    const range = resolveRange(q);
    const rows = await this.queries.exportOrders(range.from, range.to, EXPORT_MAX_ROWS);
    if (rows.length > EXPORT_MAX_ROWS) {
      throw new BadRequestException(
        `More than ${EXPORT_MAX_ROWS} orders in this range: narrow the dates`,
      );
    }
    await this.recordExport(user, req, 'orders', range);
    return toCsv(
      [
        'orderNumber',
        'paidAt',
        'status',
        'subtotalMinor',
        'shippingMinor',
        'totalMinor',
        'refundedMinor',
        'units',
        'currency',
      ],
      rows.map((r) => [
        r.orderNumber,
        r.paidAt.toISOString(),
        r.status,
        r.subtotal,
        r.shipping,
        r.total,
        Number(r.refunded),
        Number(r.units),
        r.currency,
      ]),
    );
  }

  private recordExport(
    user: AuthUser,
    req: Request,
    report: string,
    range: { from: Date; to: Date },
  ) {
    return this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      actorRole: user.role,
      action: 'report.export',
      entityType: 'report',
      entityId: report,
      ip: req.ip,
      metadata: { from: range.from.toISOString(), to: range.to.toISOString() },
    });
  }
}
