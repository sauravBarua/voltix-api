import { z } from 'zod';

export const envelopeSchema = z.object({
  id: z.string().min(1), // = the outbox row id, also the idempotency key of consumers
  type: z.string().min(1),
  aggregateType: z.string(),
  aggregateId: z.string(),
  occurredAt: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
export type EventEnvelope = z.infer<typeof envelopeSchema>;

/** A message that can never be processed: retrying is pointless, so it goes straight to the DLQ. */
export class PoisonMessageError extends Error {}

export function parseEnvelope(content: Buffer): EventEnvelope {
  let json: unknown;
  try {
    json = JSON.parse(content.toString('utf8'));
  } catch {
    throw new PoisonMessageError('Message body is not valid JSON');
  }
  const result = envelopeSchema.safeParse(json);
  if (!result.success) {
    const details = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new PoisonMessageError(`Invalid event envelope: ${details}`);
  }
  return result.data;
}
