import { Body, Controller, Headers, HttpCode, Param, Post } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { IdParamDto } from '../common/schemas';
import { parseIdempotencyKey } from '../orders/orders.utils';
import { RefundDto, RefundResultDto } from './payments.dto';
import { PaymentsService } from './payments.service';

// No guard until Phase 13 (administrator only afterwards)
@ApiTags('Admin payments')
@Controller('admin/orders')
export class AdminPaymentsController {
  constructor(private readonly service: PaymentsService) {}

  @Post(':id/refund')
  @HttpCode(202)
  @ApiOperation({
    summary:
      'Refund a paid order (full by default, or a partial amount). The webhook finalizes it.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8-100 characters. Reuse it when retrying the same refund so it is applied once.',
  })
  @ApiAcceptedResponse({ type: RefundResultDto })
  @ApiBadRequestResponse({
    description: 'Missing key, invalid body, amount too high, or restock on a partial refund',
  })
  @ApiNotFoundResponse()
  @ApiConflictResponse({
    description: 'No paid payment, already fully refunded, or Stripe refused the refund',
  })
  @ApiBadGatewayResponse()
  refund(
    @Param() params: IdParamDto,
    @Headers('idempotency-key') rawKey: string | undefined,
    @Body() dto: RefundDto,
  ) {
    return this.service.refund(params.id, parseIdempotencyKey(rawKey), dto);
  }
}
