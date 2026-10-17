import { Controller, HttpCode, Param, Post } from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Authenticated } from '../auth/access.decorators';
import { CurrentUserId } from '../common/auth/current-user-id.decorator';
import { IdParamDto } from '../common/schemas';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { PayResultDto } from './payments.dto';
import { PaymentsService } from './payments.service';

@ApiTags('Payments')
@Authenticated()
@Controller('orders')
export class PaymentsController {
  constructor(private readonly service: PaymentsService) {}

  @RateLimit('strict')
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
