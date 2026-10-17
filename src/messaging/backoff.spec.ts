import { backoffDelayMs, jitteredTierDelayMs } from './backoff';

describe('backoffDelayMs', () => {
  it('doubles each attempt, between 50% and 100% of the exponential value', () => {
    expect(backoffDelayMs(1, undefined, () => 0)).toBe(1_000);
    expect(backoffDelayMs(1, undefined, () => 1)).toBe(2_000);
    expect(backoffDelayMs(3, undefined, () => 0)).toBe(4_000);
    expect(backoffDelayMs(3, undefined, () => 1)).toBe(8_000);
  });

  it('is capped', () => {
    expect(backoffDelayMs(30, undefined, () => 1)).toBe(600_000);
    expect(backoffDelayMs(30, undefined, () => 0)).toBe(300_000);
  });

  it('always lands inside the jitter window', () => {
    for (let i = 0; i < 200; i++) {
      const d = backoffDelayMs(4);
      expect(d).toBeGreaterThanOrEqual(8_000);
      expect(d).toBeLessThanOrEqual(16_000);
    }
  });
});

describe('jitteredTierDelayMs', () => {
  it('stays within 50-100% of the tier', () => {
    expect(jitteredTierDelayMs(1_000, () => 0)).toBe(500);
    expect(jitteredTierDelayMs(1_000, () => 1)).toBe(1_000);
  });
});
