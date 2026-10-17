import { Body, Controller, Get, Headers, Param, Post, Query, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { Authenticated } from '../auth/access.decorators';
import { CurrentUserId } from '../common/auth/current-user-id.decorator';
import { IdParamDto } from '../common/schemas';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import {
  CheckoutDto,
  CheckoutResultDto,
  ListOrdersDto,
  OrderDto,
  OrderListDto,
} from './orders.dto';
import { OrdersService } from './orders.service';
import { parseIdempotencyKey } from './orders.utils';

@ApiTags('Orders')
@Authenticated()
@Controller('orders')
export class OrdersController {
  constructor(private readonly service: OrdersService) {}

  @RateLimit('strict')
  @Post('checkout')
  @ApiOperation({
    summary:
      'Turn the cart into an order and reserve its stock (200 + replayed=true on a repeated key)',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8-100 characters. Reuse the same key when retrying the same checkout.',
  })
  @ApiCreatedResponse({ type: CheckoutResultDto })
  @ApiOkResponse({ type: CheckoutResultDto, description: 'Idempotent replay' })
  @ApiBadRequestResponse({
    description: 'Missing key, invalid address, empty cart or total too high',
  })
  @ApiConflictResponse({
    description: 'Not enough stock, item unavailable, or another unpaid order exists',
  })
  async checkout(
    @CurrentUserId() userId: string,
    @Headers('idempotency-key') rawKey: string | undefined,
    @Body() dto: CheckoutDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.service.checkout(userId, parseIdempotencyKey(rawKey), dto);
    if (result.replayed) res.status(200);
    return result;
  }

  @Get()
  @ApiOperation({ summary: 'My orders, newest first' })
  @ApiOkResponse({ type: OrderListDto })
  list(@CurrentUserId() userId: string, @Query() query: ListOrdersDto) {
    return this.service.list(userId, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One of my orders (404 for orders of other users)' })
  @ApiOkResponse({ type: OrderDto })
  @ApiNotFoundResponse()
  get(@CurrentUserId() userId: string, @Param() params: IdParamDto) {
    return this.service.get(userId, params.id);
  }

  @Post(':id/cancel')
  @ApiOperation({ summary: 'Cancel an unpaid order and release its stock (idempotent)' })
  @ApiOkResponse({ type: OrderDto })
  @ApiNotFoundResponse()
  @ApiConflictResponse({ description: 'The order is already paid or shipped' })
  cancel(@CurrentUserId() userId: string, @Param() params: IdParamDto) {
    return this.service.cancel(userId, params.id);
  }
}
