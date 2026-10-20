import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConsumerRunner } from '../messaging/consumer.runner';
import type { Prisma } from '../generated/prisma/client';
import { MailService } from '../mail/mail.service';
import { orderPaidEmail } from '../mail/order-paid.email';
import type { EventEnvelope } from '../messaging/envelope';
import { InvoicesService } from '../payments/invoices.service';

const EMAIL_MAX_AGE_MS = 24 * 3_600_000; // never mail old orders after a long outage or a restart

/**
 * No mail provider yet: this logs the notification it would send. Swap the body of `handle` for your
 * provider. External calls are at-least-once (a crash after sending but before commit sends again),
 * so pass the event id to the provider as its idempotency key when it supports one.
 */
@Injectable()
export class NotificationsConsumer implements OnModuleInit {
  private readonly logger = new Logger(NotificationsConsumer.name);

  constructor(
    private readonly runner: ConsumerRunner,
    private readonly mail: MailService,
    private readonly invoices: InvoicesService,
  ) {}

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
      handle: (event, tx) => this.handle(event, tx),
    });
  }

  private async handle(event: EventEnvelope, tx: Prisma.TransactionClient) {
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
    if (event.type === 'order.paid') await this.emailOrderPaid(event, orderId, tx);
    this.logger.log(`[notification] ${event.type} order=${orderId}`);
  }

  private async emailOrderPaid(
    event: EventEnvelope,
    orderId: string,
    tx: Prisma.TransactionClient,
  ) {
    if (!this.mail.enabled) return;
    const age = Date.now() - Date.parse(event.occurredAt);
    if (age > EMAIL_MAX_AGE_MS) {
      this.logger.warn(
        `Order ${orderId}: confirmation email skipped, event is ${Math.round(age / 3_600_000)} h old`,
      );
      return;
    }
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        orderNumber: true,
        totalMinor: true,
        currency: true,
        user: { select: { email: true, name: true } },
      },
    });
    if (!order) return;

    const invoice = await this.invoices.pdf(tx, orderId); // creates the number once, in this transaction
    const mail = orderPaidEmail({
      name: order.user.name,
      orderNumber: order.orderNumber,
      totalMinor: order.totalMinor,
      currency: order.currency,
      invoice: invoice ? { number: invoice.number } : undefined,
    });
    await this.mail.send({
      to: order.user.email,
      ...mail,
      attachments: invoice
        ? [
            {
              filename: `${invoice.number}.pdf`,
              content: invoice.buffer,
              contentType: 'application/pdf',
            },
          ]
        : undefined,
    });
  }
}
