import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type Stripe from 'stripe';
import { PrismaService } from '../prisma/prisma.service';
import { StripeWebhookService } from '../payments/stripe-webhook.service';
import { StripeService } from '../payments/stripe.service';
import { JobScheduler } from './job-scheduler';
import { JOB_SCHEDULE } from './jobs.constants';

const STUCK_AFTER_MINUTES = 35; // sessions last 31 minutes
const REFUND_RETRY_AFTER_MINUTES = 5;
const SESSION_BATCH = 50;
const REFUND_BATCH = 20;
const AUTO_REFUND_REASON = 'PAID_AFTER_EXPIRY_NO_STOCK';

type Kind = 'checkout.session.completed' | 'checkout.session.expired' | 'charge.refunded';

/** A webhook-shaped event with a deterministic id, so repeating it is a no-op in the webhook handler. */
function synthetic(type: Kind, key: string, object: unknown): Stripe.Event {
  return {
    id: `recon:${key}`,
    object: 'event',
    api_version: null,
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type,
    data: { object },
  } as unknown as Stripe.Event;
}

const isMissing = (error: unknown) =>
  (error as { code?: unknown } | null)?.code === 'resource_missing';

/**
 * Asks Stripe what really happened for payments the webhook never settled, then applies it through the
 * SAME code as the webhook (so there is one set of rules). The real webhook arriving later is a no-op.
 */
@Injectable()
export class PaymentReconciliationJob implements OnModuleInit {
  private readonly logger = new Logger(PaymentReconciliationJob.name);

  constructor(
    private readonly scheduler: JobScheduler,
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly webhook: StripeWebhookService,
  ) {}

  onModuleInit() {
    this.scheduler.register({
      name: 'payment-reconciliation',
      ...JOB_SCHEDULE['payment-reconciliation'],
      run: () => this.run(),
    });
  }

  async run() {
    const counts = {
      checked: 0,
      paymentsApplied: 0,
      expiriesApplied: 0,
      stillOpen: 0,
      missingSessions: 0,
      refundsRetried: 0,
      refundsSynced: 0,
      errors: 0,
    };
    await this.settleStuckPayments(counts);
    await this.finishAutoRefunds(counts);
    return counts;
  }

  private async settleStuckPayments(counts: Record<string, number>) {
    const cutoff = new Date(Date.now() - STUCK_AFTER_MINUTES * 60_000);
    const stuck = await this.prisma.payment.findMany({
      where: { status: 'PENDING', createdAt: { lt: cutoff } },
      orderBy: { createdAt: 'asc' },
      take: SESSION_BATCH,
      select: { id: true, stripeSessionId: true },
    });

    for (const payment of stuck) {
      counts.checked++;
      try {
        const session = await this.stripe.client.checkout.sessions.retrieve(
          payment.stripeSessionId,
        );
        if (session.status === 'complete' && session.payment_status === 'paid') {
          const result = await this.webhook.handle(
            synthetic('checkout.session.completed', `completed:${session.id}`, session),
          );
          if (result.status === 'processed') counts.paymentsApplied++;
        } else if (session.status === 'expired') {
          const result = await this.webhook.handle(
            synthetic('checkout.session.expired', `expired:${session.id}`, session),
          );
          if (result.status === 'processed') counts.expiriesApplied++;
        } else {
          counts.stillOpen++; // open, or complete but not paid yet: leave it
        }
      } catch (error) {
        if (isMissing(error)) {
          // A session Stripe does not know can never be paid
          await this.prisma.payment.updateMany({
            where: { id: payment.id, status: 'PENDING' },
            data: { status: 'EXPIRED', failureReason: 'SESSION_NOT_FOUND' },
          });
          counts.missingSessions++;
        } else {
          counts.errors++;
          this.logger.error(
            `Payment ${payment.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  }

  /** Late payments with no stock left must be refunded; a failed post-commit refund is retried here. */
  private async finishAutoRefunds(counts: Record<string, number>) {
    const cutoff = new Date(Date.now() - REFUND_RETRY_AFTER_MINUTES * 60_000);
    const rows = await this.prisma.payment.findMany({
      where: {
        status: 'PAID',
        failureReason: AUTO_REFUND_REASON,
        refundedMinor: 0,
        updatedAt: { lt: cutoff },
        stripePaymentIntentId: { not: null },
      },
      orderBy: { updatedAt: 'asc' },
      take: REFUND_BATCH,
      select: { id: true, orderId: true, amountMinor: true, stripePaymentIntentId: true },
    });

    for (const row of rows) {
      const intentId = row.stripePaymentIntentId;
      if (!intentId) continue;
      try {
        const intent = await this.stripe.client.paymentIntents.retrieve(intentId, {
          expand: ['latest_charge'],
        });
        const charge =
          typeof intent.latest_charge === 'object' && intent.latest_charge !== null
            ? intent.latest_charge
            : null;

        if (charge && charge.amount_refunded > 0) {
          // Stripe already refunded, the webhook was missed: record it
          await this.webhook.handle(
            synthetic('charge.refunded', `refunded:${row.id}:${charge.amount_refunded}`, charge),
          );
          counts.refundsSynced++;
        } else {
          await this.stripe.client.refunds.create(
            {
              payment_intent: intentId,
              amount: row.amountMinor,
              metadata: {
                orderId: row.orderId,
                paymentId: row.id,
                restock: 'false',
                note: AUTO_REFUND_REASON,
              },
            },
            { idempotencyKey: `auto-refund:${row.id}` },
          );
          counts.refundsRetried++;
        }
      } catch (error) {
        counts.errors++;
        this.logger.error(
          `Auto-refund of payment ${row.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
