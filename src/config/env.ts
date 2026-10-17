import { z } from 'zod';

// Grows phase by phase (REDIS_URL in Phase 12, ...)
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL'),
    CLOUDINARY_CLOUD_NAME: z.string().min(1),
    CLOUDINARY_API_KEY: z.string().min(1),
    CLOUDINARY_API_SECRET: z.string().min(1),
    // Must outlive the Stripe Checkout Session (minimum 30 min)
    RESERVATION_TTL_MINUTES: z.coerce.number().int().min(31).max(1440).default(32),
    STRIPE_SECRET_KEY: z
      .string()
      .regex(/^(sk|rk)_(test|live)_[A-Za-z0-9_]+$/, 'must be a Stripe secret key (sk_test_...)'),
    STRIPE_WEBHOOK_SECRET: z
      .string()
      .regex(/^whsec_[A-Za-z0-9_]+$/, 'must be a Stripe webhook signing secret (whsec_...)'),
    FRONTEND_URL: z
      .url()
      .transform((u) => u.replace(/\/+$/, ''))
      .default('http://localhost:3001'),
    RABBITMQ_URL: z
      .string()
      .regex(/^amqps?:\/\//, 'must be an amqp:// URL')
      .default('amqp://voltix:voltix@localhost:5672'),
  })
  .refine((e) => e.NODE_ENV === 'production' || !e.STRIPE_SECRET_KEY.includes('_live_'), {
    message: 'Live Stripe keys are not allowed outside production',
    path: ['STRIPE_SECRET_KEY'],
  });

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    throw new Error(`Invalid environment variables:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
