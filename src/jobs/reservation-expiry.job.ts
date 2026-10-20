import { Injectable, OnModuleInit } from '@nestjs/common';
import { ReservationsService } from '../reservations/reservations.service';
import { JobScheduler } from './job-scheduler';
import { JOB_SCHEDULE } from './jobs.constants';

const BATCH = 100;
const MAX_BATCHES = 5;

/** Frees the stock of unpaid orders whose reservation ran out (and closes their Stripe sessions). */
@Injectable()
export class ReservationExpiryJob implements OnModuleInit {
  constructor(
    private readonly scheduler: JobScheduler,
    private readonly reservations: ReservationsService,
  ) {}

  onModuleInit() {
    this.scheduler.register({
      name: 'reservation-expiry',
      ...JOB_SCHEDULE['reservation-expiry'],
      run: () => this.run(),
    });
  }

  async run() {
    let expiredOrders = 0;
    let failedOrders = 0;
    for (let i = 0; i < MAX_BATCHES; i++) {
      const batch = await this.reservations.expireDue({ limit: BATCH });
      expiredOrders += batch.expiredOrders;
      failedOrders += batch.failedOrders;
      if (batch.expiredOrders + batch.failedOrders < BATCH) break;
    }
    return { expiredOrders, failedOrders };
  }
}
