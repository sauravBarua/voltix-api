export const RATE_LIMIT_POLICIES = {
  default: { limit: 120, windowSeconds: 60 }, // everything not listed below
  strict: { limit: 10, windowSeconds: 60 }, // checkout, pay, refund: expensive or money-moving
  upload: { limit: 20, windowSeconds: 60 }, // multipart writes
} as const;

export type RateLimitPolicyName = keyof typeof RATE_LIMIT_POLICIES;

/** Injectable so tests can switch limiting on (it is off when NODE_ENV=test). */
export const RATE_LIMIT_OPTIONS = Symbol('RATE_LIMIT_OPTIONS');
export type RateLimitOptions = { enabled: boolean };
