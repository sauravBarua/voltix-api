import { SetMetadata } from '@nestjs/common';
import type { RateLimitPolicyName } from './rate-limit.constants';

export const RATE_LIMIT_KEY = 'rateLimitPolicy';

export const RateLimit = (policy: RateLimitPolicyName) => SetMetadata(RATE_LIMIT_KEY, policy);
/** Health probes and the Stripe webhook (authenticated by its signature). */
export const SkipRateLimit = () => SetMetadata(RATE_LIMIT_KEY, 'skip');
