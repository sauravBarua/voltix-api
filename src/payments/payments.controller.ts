import { Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiConflictResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUserId } from '../common/auth/current-user-id.decorator';
import { DevUserGuard } from '../common/auth/dev-user.guard';
import { IdParamDto } from '../common/schemas';
import { PayResultDto } from './payments.dto';
import { PaymentsService } from './payments.service';

@ApiTags('Payments')
@ApiHeader({
  name: 'x-user-id',
  required: true,
  description: 'TEMPORARY until Phase 13: id of the shopper (dev/test only, refused in production)',
})
@ApiUnauthorizedResponse({ description: 'Missing, invalid or unknown x-user-id' })
@UseGuards(DevUserGuard)
@Controller('orders')
export class PaymentsController {
  constructor(private readonly service: PaymentsService) {}

  @Post(':id/pay')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Create the Stripe Checkout Session of an unpaid order (idempotent: returns the open session)',
  })
  @ApiOkResponse({ type: PayResultDto })
  @ApiNotFoundResponse({ description: 'Order not found (or not yours)' })
  @ApiConflictResponse({
    description: 'Order not awaiting payment, reservation expired, or session closed',
  })
  @ApiBadGatewayResponse({ description: 'Stripe returned an error' })
  pay(@CurrentUserId() userId: string, @Param() params: IdParamDto) {
    return this.service.createCheckoutSession(userId, params.id);
  }
}
