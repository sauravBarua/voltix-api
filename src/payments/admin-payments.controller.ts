import { Roles } from '../auth/access.decorators';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import { IdParamDto } from '../common/schemas';
import { parseIdempotencyKey } from '../orders/orders.utils';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { InvoicesService } from './invoices.service';
import { RefundDto, RefundResultDto } from './payments.dto';
import { PaymentsService } from './payments.service';

// No guard until Phase 13 (administrator only afterwards)
@ApiTags('Admin payments')
@Roles('ADMIN')
@Controller('admin/orders')
export class AdminPaymentsController {
  constructor(
    private readonly service: PaymentsService,
    private readonly invoices: InvoicesService,
  ) {}

  @Get(':id/invoice')
  @ApiProduces('application/pdf')
  @ApiOperation({ summary: 'Invoice PDF of any paid order' })
  @ApiNotFoundResponse()
  async invoice(@Param() params: IdParamDto) {
    const { number, buffer } = await this.invoices.forAdmin(params.id);
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `attachment; filename="${number}.pdf"`,
    });
  }

  @RateLimit('strict')
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
