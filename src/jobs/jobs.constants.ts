export const JOB_NAMES = [
  'reservation-expiry',
  'low-stock-alerts',
  'stock-reconciliation',
  'payment-reconciliation',
  'cleanup',
] as const;
export type JobName = (typeof JOB_NAMES)[number];

const minutes = (n: number) => n * 60_000;

/** Lease = how long a run may take before another worker is allowed to take over. */
export const JOB_SCHEDULE: Record<JobName, { intervalMs: number; leaseSeconds: number }> = {
  'reservation-expiry': { intervalMs: 30_000, leaseSeconds: 120 },
  'low-stock-alerts': { intervalMs: minutes(5), leaseSeconds: 120 },
  'stock-reconciliation': { intervalMs: minutes(10), leaseSeconds: 300 },
  'payment-reconciliation': { intervalMs: minutes(5), leaseSeconds: 300 },
  cleanup: { intervalMs: minutes(60), leaseSeconds: 1_800 },
};

/** Injectable so the scheduler can stay off under NODE_ENV=test. */
export const JOBS_OPTIONS = Symbol('JOBS_OPTIONS');
export type JobsOptions = { autoStart: boolean };
