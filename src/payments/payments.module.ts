import { Module } from '@nestjs/common';
import { ReservationsModule } from '../reservations/reservations.module';
import { AdminPaymentsController } from './admin-payments.controller';
import { InvoicesService } from './invoices.service';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { StripeWebhookController } from './stripe-webhook.controller';
import { StripeWebhookService } from './stripe-webhook.service';
import { StripeService } from './stripe.service';

@Module({
  imports: [ReservationsModule],
  controllers: [PaymentsController, AdminPaymentsController, StripeWebhookController],
  providers: [StripeService, PaymentsService, StripeWebhookService, InvoicesService],
  exports: [PaymentsService, StripeService, StripeWebhookService, InvoicesService],
})
export class PaymentsModule {}
