import { Roles } from '../auth/access.decorators';
import { Body, Controller, Get, Param, Patch, Post, Query, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import {
  AdjustmentDto,
  InventoryItemDto,
  InventoryListDto,
  ListInventoryDto,
  ListMovementsDto,
  MovementListDto,
  ReorderLevelDto,
  StockInDto,
  StockMutationDto,
  StockOutDto,
  VariantIdParamDto,
} from './inventory.dto';
import { InventoryService } from './inventory.service';

@ApiTags('Inventory')
@Roles('INVENTORY_OPERATOR', 'ADMIN')
@Controller('inventory')
export class InventoryController {
  constructor(private readonly service: InventoryService) {}

  @Get()
  @ApiOperation({
    summary: 'List stock per variant; status=low|out for alerts (operator/admin from Phase 13)',
  })
  @ApiOkResponse({ type: InventoryListDto })
  list(@Query() query: ListInventoryDto) {
    return this.service.list(query);
  }

  @Get('movements')
  @ApiOperation({ summary: 'Movements ledger, newest first' })
  @ApiOkResponse({ type: MovementListDto })
  movements(@Query() query: ListMovementsDto) {
    return this.service.listMovements(query);
  }

  @Get('variants/:variantId')
  @ApiOperation({ summary: 'Stock of one variant' })
  @ApiOkResponse({ type: InventoryItemDto })
  @ApiNotFoundResponse()
  get(@Param() params: VariantIdParamDto) {
    return this.service.getItem(params.variantId);
  }

  @Post('variants/:variantId/stock-in')
  @ApiOperation({
    summary: 'Receive stock (200 + replayed=true when the idempotencyKey was already used)',
  })
  @ApiCreatedResponse({ type: StockMutationDto })
  @ApiOkResponse({ type: StockMutationDto, description: 'Idempotent replay' })
  @ApiBadRequestResponse()
  @ApiNotFoundResponse()
  async stockIn(
    @Param() params: VariantIdParamDto,
    @Body() dto: StockInDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.respond(res, await this.service.stockIn(params.variantId, dto));
  }

  @Post('variants/:variantId/stock-out')
  @ApiOperation({ summary: 'Remove stock (reason required). Cannot take reserved units.' })
  @ApiCreatedResponse({ type: StockMutationDto })
  @ApiOkResponse({ type: StockMutationDto, description: 'Idempotent replay' })
  @ApiBadRequestResponse()
  @ApiNotFoundResponse()
  @ApiConflictResponse({ description: 'Not enough available stock' })
  async stockOut(
    @Param() params: VariantIdParamDto,
    @Body() dto: StockOutDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.respond(res, await this.service.stockOut(params.variantId, dto));
  }

  @Post('variants/:variantId/adjustments')
  @ApiOperation({ summary: 'Signed correction (stocktake, damage, loss). Reason required.' })
  @ApiCreatedResponse({ type: StockMutationDto })
  @ApiOkResponse({ type: StockMutationDto, description: 'Idempotent replay' })
  @ApiBadRequestResponse()
  @ApiNotFoundResponse()
  @ApiConflictResponse({ description: 'Would drop on-hand below reserved units' })
  async adjust(
    @Param() params: VariantIdParamDto,
    @Body() dto: AdjustmentDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.respond(res, await this.service.adjust(params.variantId, dto));
  }

  @Patch('variants/:variantId/reorder-level')
  @ApiOperation({ summary: 'Set the low-stock threshold (not a stock movement)' })
  @ApiOkResponse({ type: InventoryItemDto })
  @ApiBadRequestResponse()
  @ApiNotFoundResponse()
  setReorderLevel(@Param() params: VariantIdParamDto, @Body() dto: ReorderLevelDto) {
    return this.service.setReorderLevel(params.variantId, dto.reorderLevel);
  }

  private respond<T extends { replayed: boolean }>(res: Response, result: T): T {
    if (result.replayed) res.status(200);
    return result;
  }
}
