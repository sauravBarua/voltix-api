import { Module } from '@nestjs/common';
import { ReservationHooks } from './reservation-hooks';
import { ReservationsController } from './reservations.controller';
import { ReservationsService } from './reservations.service';

@Module({
  controllers: [ReservationsController],
  providers: [ReservationsService, ReservationHooks],
  exports: [ReservationsService, ReservationHooks],
})
export class ReservationsModule {}
