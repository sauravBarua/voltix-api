import { Injectable, Logger } from '@nestjs/common';

type Handler = (orderIds: string[]) => Promise<void>;

/**
 * Lets other modules react to expired reservations without Reservations depending on them
 * (Payments closes the Stripe Checkout Session). Handlers run after the transactions commit.
 */
@Injectable()
export class ReservationHooks {
  private readonly logger = new Logger(ReservationHooks.name);
  private readonly handlers: Handler[] = [];

  onExpired(handler: Handler) {
    this.handlers.push(handler);
  }

  async runExpired(orderIds: string[]) {
    for (const handler of this.handlers) {
      try {
        await handler(orderIds);
      } catch (error) {
        this.logger.error(
          `Expiry hook failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
