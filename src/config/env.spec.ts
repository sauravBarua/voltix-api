import { validateEnv } from './env';

const DATABASE_URL = 'postgresql://u:p@localhost:5432/db';

describe('validateEnv', () => {
  it('applies defaults', () => {
    expect(validateEnv({ DATABASE_URL })).toEqual({
      NODE_ENV: 'development',
      PORT: 3000,
      DATABASE_URL,
    });
  });

  it('coerces PORT from string', () => {
    expect(validateEnv({ DATABASE_URL, PORT: '4000' }).PORT).toBe(4000);
  });

  it('throws on invalid NODE_ENV', () => {
    expect(() => validateEnv({ DATABASE_URL, NODE_ENV: 'nope' })).toThrow(
      /Invalid environment variables/,
    );
  });

  it('throws when DATABASE_URL is missing or not postgres', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL/);
    expect(() => validateEnv({ DATABASE_URL: 'mysql://x' })).toThrow(/DATABASE_URL/);
  });
});
