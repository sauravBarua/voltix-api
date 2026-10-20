import { Controller, Get, HttpCode, Param, Post, StreamableFile } from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import { Authenticated } from '../auth/access.decorators';
import { CurrentUserId } from '../common/auth/current-user-id.decorator';
import { IdParamDto } from '../common/schemas';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { InvoicesService } from './invoices.service';
import { PayResultDto } from './payments.dto';
import { PaymentsService } from './payments.service';

@ApiTags('Payments')
@Authenticated()
@Controller('orders')
export class PaymentsController {
  constructor(
    private readonly service: PaymentsService,
    private readonly invoices: InvoicesService,
  ) {}

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

  @Get(':id/invoice')
  @ApiProduces('application/pdf')
  @ApiOperation({ summary: 'Invoice PDF of a paid order (owner only)' })
  @ApiNotFoundResponse({ description: 'Not your order, or not paid yet' })
  async invoice(@CurrentUserId() userId: string, @Param() params: IdParamDto) {
    const { number, buffer } = await this.invoices.forOwner(userId, params.id);
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `attachment; filename="${number}.pdf"`,
    });
  }
}
