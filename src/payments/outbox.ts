import type { Prisma } from '../generated/prisma/client';

/** Written in the same transaction as the state change; Phase 11 publishes these rows to RabbitMQ. */
export function enqueueOutbox(
  tx: Prisma.TransactionClient,
  event: { aggregateId: string; type: string; payload: Prisma.InputJsonObject },
) {
  return tx.outboxEvent.create({
    data: {
      aggregateType: 'order',
      aggregateId: event.aggregateId,
      type: event.type,
      payload: event.payload,
    },
    select: { id: true },
  });
}
