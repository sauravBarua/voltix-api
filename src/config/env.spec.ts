import { validateEnv } from './env';

describe('validateEnv', () => {
  it('applies defaults', () => {
    expect(validateEnv({})).toEqual({ NODE_ENV: 'development', PORT: 3000 });
  });

  it('coerces PORT from string', () => {
    expect(validateEnv({ PORT: '4000' }).PORT).toBe(4000);
  });

  it('throws on invalid NODE_ENV', () => {
    expect(() => validateEnv({ NODE_ENV: 'nope' })).toThrow(/Invalid environment variables/);
  });
});
