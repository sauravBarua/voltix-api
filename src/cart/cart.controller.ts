import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Authenticated } from '../auth/access.decorators';
import { CurrentUserId } from '../common/auth/current-user-id.decorator';
import { AddCartItemDto, CartDto, CartVariantParamDto, SetCartItemQuantityDto } from './cart.dto';
import { CartService } from './cart.service';

@ApiTags('Cart')
@Authenticated()
@Controller('cart')
export class CartController {
  constructor(private readonly service: CartService) {}

  @Get()
  @ApiOperation({ summary: 'Current cart with live prices and per-line stock status' })
  @ApiOkResponse({ type: CartDto })
  get(@CurrentUserId() userId: string) {
    return this.service.get(userId);
  }

  @Post('items')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Add units of a variant (increments if already in the cart). Does not reserve stock.',
  })
  @ApiOkResponse({ type: CartDto })
  @ApiBadRequestResponse({ description: 'Invalid body or more than 10 units of one item' })
  @ApiNotFoundResponse({ description: 'Variant not found or deactivated' })
  @ApiConflictResponse({ description: 'Not enough stock, or cart is full' })
  add(@CurrentUserId() userId: string, @Body() dto: AddCartItemDto) {
    return this.service.addItem(userId, dto);
  }

  @Patch('items/:variantId')
  @ApiOperation({ summary: 'Set the quantity of a line (reducing is always allowed)' })
  @ApiOkResponse({ type: CartDto })
  @ApiBadRequestResponse()
  @ApiNotFoundResponse({ description: 'Item not in cart, or variant deactivated when increasing' })
  @ApiConflictResponse({ description: 'Not enough stock' })
  setQuantity(
    @CurrentUserId() userId: string,
    @Param() params: CartVariantParamDto,
    @Body() dto: SetCartItemQuantityDto,
  ) {
    return this.service.setQuantity(userId, params.variantId, dto.quantity);
  }

  @Delete('items/:variantId')
  @ApiOperation({ summary: 'Remove a line' })
  @ApiOkResponse({ type: CartDto })
  @ApiNotFoundResponse({ description: 'Item not in cart' })
  remove(@CurrentUserId() userId: string, @Param() params: CartVariantParamDto) {
    return this.service.removeItem(userId, params.variantId);
  }

  @Delete()
  @ApiOperation({ summary: 'Remove every line (idempotent)' })
  @ApiOkResponse({ type: CartDto })
  clear(@CurrentUserId() userId: string) {
    return this.service.clear(userId);
  }
}
