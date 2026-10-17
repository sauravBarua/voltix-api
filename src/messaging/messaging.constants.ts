export const EVENTS_EXCHANGE = 'voltix.events'; // topic exchange, routing key = event type

// Delay of each consumer retry tier: 3 retries, then the dead-letter queue (4 tries in total)
export const DEFAULT_RETRY_DELAYS_MS = [5_000, 30_000, 300_000];
