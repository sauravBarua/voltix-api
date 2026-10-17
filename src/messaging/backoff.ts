export type BackoffOptions = { baseMs: number; capMs: number };

const DEFAULT: BackoffOptions = { baseMs: 2_000, capMs: 600_000 };

/** attempt starts at 1. Exponential growth up to a cap, with "equal jitter": half fixed, half random. */
export function backoffDelayMs(
  attempt: number,
  options: BackoffOptions = DEFAULT,
  random: () => number = Math.random,
): number {
  const exp = Math.min(options.capMs, options.baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp / 2 + random() * (exp / 2));
}

/** Delay of one message inside a retry tier: 50-100% of the tier delay (never above the queue TTL). */
export function jitteredTierDelayMs(tierMs: number, random: () => number = Math.random): number {
  return Math.round(tierMs / 2 + random() * (tierMs / 2));
}
