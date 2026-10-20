import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env';
import { PaymentsModule } from '../payments/payments.module';
import { ReservationsModule } from '../reservations/reservations.module';
import { CleanupJob } from './cleanup.job';
import { JobScheduler } from './job-scheduler';
import { JOBS_OPTIONS, type JobsOptions } from './jobs.constants';
import { LowStockAlertsJob } from './low-stock-alerts.job';
import { PaymentReconciliationJob } from './payment-reconciliation.job';
import { ReservationExpiryJob } from './reservation-expiry.job';
import { StockReconciliationJob } from './stock-reconciliation.job';

// PaymentsModule is required: expiring a reservation also closes its Stripe Checkout Session (a hook it registers)
@Module({
  imports: [ReservationsModule, PaymentsModule],
  providers: [
    {
      provide: JOBS_OPTIONS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): JobsOptions => ({
        autoStart:
          config.get('JOBS_ENABLED', { infer: true }) ??
          config.get('NODE_ENV', { infer: true }) !== 'test',
      }),
    },
    JobScheduler,
    ReservationExpiryJob,
    LowStockAlertsJob,
    StockReconciliationJob,
    PaymentReconciliationJob,
    CleanupJob,
  ],
  exports: [JobScheduler],
})
export class JobsModule {}
