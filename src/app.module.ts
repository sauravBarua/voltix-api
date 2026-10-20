import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ZodValidationPipe } from 'nestjs-zod';
import { AuditInterceptor } from './audit/audit.interceptor';
import { AccessGuard } from './auth/access.guard';
import { AuthModule } from './auth/auth.module';
import { CartModule } from './cart/cart.module';
import { CatalogModule } from './catalog/catalog.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { PrismaExceptionFilter } from './common/filters/prisma-exception.filter';
import { validateEnv } from './config/env';
import { HealthModule } from './health/health.module';
import { InventoryModule } from './inventory/inventory.module';
import { JobsAdminModule } from './jobs/jobs-admin.module';
import { OrdersModule } from './orders/orders.module';
import { OutboxModule } from './outbox/outbox.module';
import { PaymentsModule } from './payments/payments.module';
import { PrismaModule } from './prisma/prisma.module';
import { RateLimitGuard } from './rate-limit/rate-limit.guard';
import { RateLimitModule } from './rate-limit/rate-limit.module';
import { RealtimeModule } from './realtime/realtime.module';
import { RedisModule } from './redis/redis.module';
import { ReservationsModule } from './reservations/reservations.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    PrismaModule,
    RedisModule,
    RateLimitModule,
    AuthModule,
    HealthModule,
    CatalogModule,
    InventoryModule,
    CartModule,
    ReservationsModule,
    PaymentsModule,
    OrdersModule,
    OutboxModule,
    RealtimeModule,
    JobsAdminModule,
    DashboardModule,
  ],
  providers: [
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_FILTER, useClass: PrismaExceptionFilter },
    // Same array = deterministic order: rate limit first (so 401s are counted too), then access control
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: AccessGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule {}
