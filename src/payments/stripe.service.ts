import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import type { Env } from '../config/env';

/** The only place that builds the Stripe client (and the e2e fake target). */
@Injectable()
export class StripeService {
  readonly client: Stripe;
  readonly webhookSecret: string;
  readonly frontendUrl: string;

  constructor(config: ConfigService<Env, true>) {
    // No apiVersion: the SDK pins the API version it was built and typed against.
    // Retries are safe because every creating call carries an idempotency key.
    this.client = new Stripe(config.get('STRIPE_SECRET_KEY', { infer: true }), {
      maxNetworkRetries: 2,
      timeout: 20_000,
      appInfo: { name: 'voltix-api' },
    });
    this.webhookSecret = config.get('STRIPE_WEBHOOK_SECRET', { infer: true });
    this.frontendUrl = config.get('FRONTEND_URL', { infer: true });
  }
}
