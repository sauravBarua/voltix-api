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
    REDIS_URL: z
      .string()
      .regex(/^rediss?:\/\//, 'must be a redis:// URL')
      .default('redis://localhost:6379'),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
    RATE_LIMIT_ENABLED: z.stringbool().optional(),
    JWT_ACCESS_SECRET: z
      .string()
      .min(32, 'must be at least 32 characters (generate it, never type it)'),
    ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().min(1).max(60).default(15),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    AUDIT_RETENTION_DAYS: z.coerce.number().int().min(90).max(3650).default(365),
    JOBS_ENABLED: z.stringbool().optional(),
    SMTP_HOST: z.string().min(1).optional(),
    SMTP_PORT: z.coerce.number().int().positive().optional(), // 465 = TLS from the start
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASS: z.string().min(1).optional(),
    SELLER_NAME: z.string().min(1).default('Voltix'),
    SELLER_ADDRESS: z.string().default(''),
    SELLER_SIREN: z.string().optional(),
    SELLER_VAT_NUMBER: z.string().optional(),
    VAT_RATE_PERCENT: z.coerce.number().min(0).max(30).default(20),
    MAIL_FROM: z.string().min(3).optional(),
    MAIL_ENABLED: z.stringbool().optional(),
  })
  .refine((e) => e.NODE_ENV === 'production' || !e.STRIPE_SECRET_KEY.includes('_live_'), {
    message: 'Live Stripe keys are not allowed outside production',
    path: ['STRIPE_SECRET_KEY'],
  })
  .refine(
    (e) =>
      [e.SMTP_HOST, e.SMTP_USER, e.SMTP_PASS].every(Boolean) ||
      ![e.SMTP_HOST, e.SMTP_USER, e.SMTP_PASS].some(Boolean),
    {
      message: 'SMTP_HOST, SMTP_USER and SMTP_PASS must be set together',
      path: ['SMTP_HOST'],
    },
  );

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    throw new Error(`Invalid environment variables:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
