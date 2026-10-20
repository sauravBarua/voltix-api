import { Module } from '@nestjs/common';
import { DashboardInventoryController } from './dashboard-inventory.controller';
import { DashboardController } from './dashboard.controller';
import { DashboardQueries } from './dashboard.queries';
import { DashboardService } from './dashboard.service';

@Module({
  controllers: [DashboardController, DashboardInventoryController],
  providers: [DashboardQueries, DashboardService],
})
export class DashboardModule {}
