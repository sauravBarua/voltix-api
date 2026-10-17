import { validateEnv } from './env';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  CLOUDINARY_CLOUD_NAME: 'cloud',
  CLOUDINARY_API_KEY: 'key',
  CLOUDINARY_API_SECRET: 'secret',
  STRIPE_SECRET_KEY: 'sk_test_dummy',
  STRIPE_WEBHOOK_SECRET: 'whsec_dummy',
};

describe('validateEnv', () => {
  it('applies defaults', () => {
    expect(validateEnv(base)).toEqual({
      NODE_ENV: 'development',
      PORT: 3000,
      RESERVATION_TTL_MINUTES: 32,
      FRONTEND_URL: 'http://localhost:3001',
      ...base,
    });
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
});
