import { BadRequestException, Controller, Headers, HttpCode, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import type Stripe from 'stripe';
import { SkipRateLimit } from '../rate-limit/rate-limit.decorator';
import { StripeWebhookService } from './stripe-webhook.service';
import { StripeService } from './stripe.service';

/** POST /webhooks/stripe (outside /api/v1, see app.setup.ts). Public: authenticated by the signature. */
@ApiExcludeController()
@SkipRateLimit()
@Controller('webhooks')
export class StripeWebhookController {
  constructor(
    private readonly stripe: StripeService,
    private readonly service: StripeWebhookService,
  ) {}

  @Post('stripe')
  @HttpCode(200)
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature?: string,
  ) {
    if (!signature || !req.rawBody)
      throw new BadRequestException('Missing Stripe signature or body');

    let event: Stripe.Event;
    try {
      // The signature is computed over the exact raw bytes (rawBody: true in main.ts)
      event = this.stripe.client.webhooks.constructEvent(
        req.rawBody,
        signature,
        this.stripe.webhookSecret,
      );
    } catch {
      throw new BadRequestException('Invalid Stripe signature');
    }

    const result = await this.service.handle(event);
    return { received: true, ...result };
  }
}
