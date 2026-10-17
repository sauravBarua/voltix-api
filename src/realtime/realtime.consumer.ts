import { Injectable, OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import { ConsumerRunner } from '../messaging/consumer.runner';
import { PoisonMessageError } from '../messaging/envelope';
import { ORDER_EVENT_TYPES, inventoryMessage, isStale, orderMessages } from './realtime.messages';
import { RealtimePublisher } from './realtime.publisher';

const MAX_VARIANTS = 200;
const inventoryPayload = z.object({ variantIds: z.array(z.uuid()).max(1000) });

/**
 * Worker side: turns committed business events into real-time messages. Reads current state from
 * Postgres, so a late or duplicated event still shows the truth. Retries are short: stale news is useless.
 */
@Injectable()
export class RealtimeConsumer implements OnModuleInit {
  constructor(
    private readonly runner: ConsumerRunner,
    private readonly publisher: RealtimePublisher,
  ) {}

  onModuleInit() {
    return this.runner.register({
      name: 'realtime',
      routingKeys: ['inventory.changed', ...ORDER_EVENT_TYPES],
      retryDelaysMs: [2_000, 10_000],
      prefetch: 50,
      handle: async (event, tx) => {
        if (isStale(event.occurredAt)) return;

        if (event.type === 'inventory.changed') {
          const payload = inventoryPayload.safeParse(event.payload);
          if (!payload.success)
            throw new PoisonMessageError('inventory.changed payload is invalid');
          const rows = await tx.inventoryItem.findMany({
            where: { variantId: { in: payload.data.variantIds.slice(0, MAX_VARIANTS) } },
            select: {
              variantId: true,
              onHand: true,
              reserved: true,
              reorderLevel: true,
              variant: { select: { sku: true } },
            },
          });
          const message = inventoryMessage(
            event.id,
            rows.map((r) => ({
              variantId: r.variantId,
              sku: r.variant.sku,
              onHand: r.onHand,
              reserved: r.reserved,
              reorderLevel: r.reorderLevel,
            })),
          );
          if (message) await this.publisher.publish(message);
          return;
        }

        const order = await tx.order.findUnique({
          where: { id: event.aggregateId },
          select: {
            userId: true,
            orderNumber: true,
            status: true,
            totalMinor: true,
            currency: true,
            createdAt: true,
          },
        });
        if (!order) return;
        for (const message of orderMessages(event, order)) await this.publisher.publish(message);
      },
    });
  }
}
