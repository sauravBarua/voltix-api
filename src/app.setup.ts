import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from './config/env';
import { RealtimeAdapter } from './realtime/realtime.adapter';

export const API_PREFIX = 'api/v1';

/** Shared by main.ts and the e2e tests so both see the same routes. */
export function configureApp(app: INestApplication) {
  app.setGlobalPrefix(API_PREFIX, {
    // Infra-facing routes keep fixed paths (probes, Stripe CLI/dashboard webhook URL)
    exclude: ['health', 'health/ready', 'webhooks/stripe'],
  });
  app.enableShutdownHooks();
  const frontendUrl = app
    .get<ConfigService<Env, true>>(ConfigService)
    .get('FRONTEND_URL', { infer: true });
  app.useWebSocketAdapter(new RealtimeAdapter(app, frontendUrl));
}
