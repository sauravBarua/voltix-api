import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConsumerRunner } from '../messaging/consumer.runner';
import type { EventEnvelope } from '../messaging/envelope';

/**
 * No mail provider yet: this logs the notification it would send. Swap the body of `handle` for your
 * provider. External calls are at-least-once (a crash after sending but before commit sends again),
 * so pass the event id to the provider as its idempotency key when it supports one.
 */
@Injectable()
export class NotificationsConsumer implements OnModuleInit {
  private readonly logger = new Logger(NotificationsConsumer.name);

  constructor(private readonly runner: ConsumerRunner) {}

  onModuleInit() {
    return this.runner.register({
      name: 'notifications',
      routingKeys: [
        'order.created',
        'order.paid',
        'order.cancelled',
        'order.shipped',
        'payment.refunded',
        'payment.auto_refund_required',
        'inventory.low_stock',
        'inventory.reconciliation_mismatch',
      ],
      handle: (event) => this.handle(event),
    });
  }

  private handle(event: EventEnvelope) {
    if (event.type === 'inventory.low_stock') {
      const p = event.payload;
      this.logger.warn(
        `[notification] ${p.outOfStock === true ? 'OUT OF STOCK' : 'LOW STOCK'} sku=${String(p.sku)} available=${String(p.available)} reorderLevel=${String(p.reorderLevel)}`,
      );
      return;
    }
    if (event.type === 'inventory.reconciliation_mismatch') {
      this.logger.error(
        `[notification] ALERT admin: stock reconciliation found ${String(event.payload.count)} mismatching variant(s)`,
      );
      return;
    }
    const orderId = String(event.payload.orderId);
    if (event.type === 'payment.auto_refund_required') {
      this.logger.warn(
        `[notification] ALERT admin: payment ${String(event.payload.paymentId)} of order ${orderId} was auto-refunded`,
      );
      return;
    }
    this.logger.log(`[notification] ${event.type} order=${orderId}`);
  }
}
