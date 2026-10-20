import { validateEnv } from './env';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  CLOUDINARY_CLOUD_NAME: 'cloud',
  CLOUDINARY_API_KEY: 'key',
  CLOUDINARY_API_SECRET: 'secret',
  STRIPE_SECRET_KEY: 'sk_test_dummy',
  STRIPE_WEBHOOK_SECRET: 'whsec_dummy',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
};

describe('validateEnv', () => {
  it('applies defaults', () => {
    expect(validateEnv(base)).toEqual({
      NODE_ENV: 'development',
      PORT: 3000,
      RESERVATION_TTL_MINUTES: 32,
      FRONTEND_URL: 'http://localhost:3001',
      RABBITMQ_URL: 'amqp://voltix:voltix@localhost:5672',
      REDIS_URL: 'redis://localhost:6379',
      TRUST_PROXY_HOPS: 0,
      ACCESS_TOKEN_TTL_MINUTES: 15,
      REFRESH_TOKEN_TTL_DAYS: 30,
      AUDIT_RETENTION_DAYS: 365,
      ...base,
    });
  });

  it('validates the jobs variables', () => {
    expect(() => validateEnv({ ...base, AUDIT_RETENTION_DAYS: '30' })).toThrow(
      /AUDIT_RETENTION_DAYS/,
    );
    expect(validateEnv({ ...base, JOBS_ENABLED: 'false' }).JOBS_ENABLED).toBe(false);
    expect(validateEnv(base).JOBS_ENABLED).toBeUndefined();
  });

  it('coerces PORT from string', () => {
    expect(validateEnv({ ...base, PORT: '4000' }).PORT).toBe(4000);
  });

  it('throws on invalid NODE_ENV', () => {
    expect(() => validateEnv({ ...base, NODE_ENV: 'nope' })).toThrow(
      /Invalid environment variables/,
    );
  });

  it('throws when DATABASE_URL is missing or not postgres', () => {
    expect(() => validateEnv({ ...base, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
    expect(() => validateEnv({ ...base, DATABASE_URL: 'mysql://x' })).toThrow(/DATABASE_URL/);
  });

  it('throws when a Cloudinary variable is missing', () => {
    expect(() => validateEnv({ ...base, CLOUDINARY_API_SECRET: undefined })).toThrow(
      /CLOUDINARY_API_SECRET/,
    );
  });

  it('rejects a reservation TTL too short for Stripe Checkout', () => {
    expect(() => validateEnv({ ...base, RESERVATION_TTL_MINUTES: '30' })).toThrow(
      /RESERVATION_TTL_MINUTES/,
    );
    expect(validateEnv({ ...base, RESERVATION_TTL_MINUTES: '45' }).RESERVATION_TTL_MINUTES).toBe(
      45,
    );
  });

  it('validates the Stripe variables', () => {
    expect(() => validateEnv({ ...base, STRIPE_SECRET_KEY: undefined })).toThrow(
      /STRIPE_SECRET_KEY/,
    );
    expect(() => validateEnv({ ...base, STRIPE_SECRET_KEY: 'pk_test_abc' })).toThrow(
      /STRIPE_SECRET_KEY/,
    );
    expect(() => validateEnv({ ...base, STRIPE_WEBHOOK_SECRET: 'nope' })).toThrow(
      /STRIPE_WEBHOOK_SECRET/,
    );
  });

  it('refuses live keys outside production', () => {
    const live = { ...base, STRIPE_SECRET_KEY: 'sk_live_abc123' };
    expect(() => validateEnv(live)).toThrow(/Live Stripe keys/);
    expect(validateEnv({ ...live, NODE_ENV: 'production' }).STRIPE_SECRET_KEY).toBe(
      'sk_live_abc123',
    );
  });

  it('strips a trailing slash from FRONTEND_URL', () => {
    expect(validateEnv({ ...base, FRONTEND_URL: 'https://shop.example.com/' }).FRONTEND_URL).toBe(
      'https://shop.example.com',
    );
  });

  it('validates RABBITMQ_URL', () => {
    expect(() => validateEnv({ ...base, RABBITMQ_URL: 'http://localhost:5672' })).toThrow(
      /RABBITMQ_URL/,
    );
    expect(
      validateEnv({ ...base, RABBITMQ_URL: 'amqps://user:pw@mq.example.com' }).RABBITMQ_URL,
    ).toBe('amqps://user:pw@mq.example.com');
  });

  it('validates the Redis and rate-limit variables', () => {
    expect(() => validateEnv({ ...base, REDIS_URL: 'http://localhost:6379' })).toThrow(/REDIS_URL/);
    expect(() => validateEnv({ ...base, TRUST_PROXY_HOPS: '9' })).toThrow(/TRUST_PROXY_HOPS/);
    expect(validateEnv({ ...base, RATE_LIMIT_ENABLED: 'false' }).RATE_LIMIT_ENABLED).toBe(false);
    expect(validateEnv(base).RATE_LIMIT_ENABLED).toBeUndefined();
  });

  it('requires a strong JWT secret', () => {
    expect(() => validateEnv({ ...base, JWT_ACCESS_SECRET: undefined })).toThrow(
      /JWT_ACCESS_SECRET/,
    );
    expect(() => validateEnv({ ...base, JWT_ACCESS_SECRET: 'short' })).toThrow(/JWT_ACCESS_SECRET/);
  });

  it('requires the SMTP settings together', () => {
    expect(() => validateEnv({ ...base, SMTP_HOST: 'smtp.example.com' })).toThrow(/SMTP_HOST/);
    expect(validateEnv({ ...base, SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASS: 'p' }).SMTP_HOST).toBe(
      'h',
    );
    expect(validateEnv(base).SMTP_HOST).toBeUndefined();
  });
});
