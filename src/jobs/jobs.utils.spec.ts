import { daysAgo, isHealthy, mismatchFingerprint, randomBetween } from './jobs.utils';

describe('mismatchFingerprint', () => {
  const a = { variantId: 'v1', onHand: 5, reserved: 1 };
  const b = { variantId: 'v2', onHand: 3, reserved: 0 };

  it('ignores order and detects any change', () => {
    expect(mismatchFingerprint([a, b])).toBe(mismatchFingerprint([b, a]));
    expect(mismatchFingerprint([a, b])).not.toBe(mismatchFingerprint([a, { ...b, onHand: 4 }]));
    expect(mismatchFingerprint([a])).not.toBe(mismatchFingerprint([a, b]));
  });
});

describe('isHealthy', () => {
  const now = Date.parse('2026-10-17T12:00:00Z');

  it('is healthy within three intervals of the last success', () => {
    expect(isHealthy(new Date(now - 100_000), 60_000, now)).toBe(true);
    expect(isHealthy(new Date(now - 200_000), 60_000, now)).toBe(false);
  });

  it('is not healthy when the job never succeeded', () => {
    expect(isHealthy(null, 60_000, now)).toBe(false);
  });
});

describe('daysAgo and randomBetween', () => {
  it('subtracts whole days', () => {
    const now = Date.parse('2026-10-17T12:00:00Z');
    expect(daysAgo(7, now).toISOString()).toBe('2026-10-10T12:00:00.000Z');
  });

  it('stays inside the range', () => {
    for (let i = 0; i < 100; i++) {
      const n = randomBetween(1_000, 2_000);
      expect(n).toBeGreaterThanOrEqual(1_000);
      expect(n).toBeLessThanOrEqual(2_000);
    }
  });
});
