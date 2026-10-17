import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { ReservationsModule } from '../reservations/reservations.module';
import { AdminOrdersController } from './admin-orders.controller';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({
  imports: [ReservationsModule, PaymentsModule],
  controllers: [OrdersController, AdminOrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
