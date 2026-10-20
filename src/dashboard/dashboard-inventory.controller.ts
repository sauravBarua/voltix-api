import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/access.decorators';
import {
  InventorySummaryDto,
  LimitQueryDto,
  MovementsDto,
  StockAlertsDto,
  StockListQueryDto,
} from './dashboard.dto';
import { DashboardService } from './dashboard.service';

/** Inventory widgets: operators and administrators. Display only: stock decisions always read Postgres. */
@ApiTags('Admin dashboard')
@Roles('INVENTORY_OPERATOR', 'ADMIN')
@Controller('admin/dashboard/inventory')
export class DashboardInventoryController {
  constructor(private readonly service: DashboardService) {}

  @Get('summary')
  @ApiOperation({ summary: 'Low and out-of-stock counts, total stock value, active reservations' })
  @ApiOkResponse({ type: InventorySummaryDto })
  summary() {
    return this.service.inventorySummary();
  }

  @Get('low-stock')
  @ApiOperation({
    summary: 'Variants at or below their reorder level (out of stock included), lowest first',
  })
  @ApiOkResponse({ type: StockAlertsDto })
  lowStock(@Query() q: StockListQueryDto) {
    return this.service.stockAlerts('low', q.limit, q.q);
  }

  @Get('out-of-stock')
  @ApiOperation({ summary: 'Variants with nothing available' })
  @ApiOkResponse({ type: StockAlertsDto })
  outOfStock(@Query() q: StockListQueryDto) {
    return this.service.stockAlerts('out', q.limit, q.q);
  }

  @Get('movements')
  @ApiOperation({ summary: 'Newest ledger entries' })
  @ApiOkResponse({ type: MovementsDto })
  movements(@Query() q: LimitQueryDto) {
    return this.service.recentMovements(q.limit);
  }
}
