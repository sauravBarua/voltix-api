import { Roles } from '../auth/access.decorators';
import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { IdParamDto } from '../common/schemas';
import { AdminListOrdersDto, AdminOrderDto, AdminOrderListDto } from './orders.dto';
import { OrdersService } from './orders.service';

// No guard until Phase 13 (administrator only afterwards)
@ApiTags('Admin orders')
@Roles('ADMIN')
@Controller('admin/orders')
export class AdminOrdersController {
  constructor(private readonly service: OrdersService) {}

  @Get()
  @ApiOperation({ summary: 'All orders with customer, newest first (admin from Phase 13)' })
  @ApiOkResponse({ type: AdminOrderListDto })
  list(@Query() query: AdminListOrdersDto) {
    return this.service.listAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One order with its customer' })
  @ApiOkResponse({ type: AdminOrderDto })
  @ApiNotFoundResponse()
  get(@Param() params: IdParamDto) {
    return this.service.getAdmin(params.id);
  }

  @Post(':id/ship')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mark a paid order as shipped (idempotent)' })
  @ApiOkResponse({ type: AdminOrderDto })
  @ApiNotFoundResponse()
  @ApiConflictResponse({ description: 'The order is not paid' })
  ship(@Param() params: IdParamDto) {
    return this.service.ship(params.id);
  }
}
