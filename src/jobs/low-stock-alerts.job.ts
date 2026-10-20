import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JobScheduler } from './job-scheduler';
import { JOB_SCHEDULE } from './jobs.constants';

const MAX_NEW_ALERTS = 50;

type Fresh = { variantId: string; sku: string; available: number; reorderLevel: number };

/**
 * Alerts once when a variant drops to or below its reorder level, and re-arms when it recovers.
 * The alert row and the outbox event commit together; the notifications consumer delivers it.
 */
@Injectable()
export class LowStockAlertsJob implements OnModuleInit {
  constructor(
    private readonly scheduler: JobScheduler,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit() {
    this.scheduler.register({
      name: 'low-stock-alerts',
      ...JOB_SCHEDULE['low-stock-alerts'],
      run: () => this.run(),
    });
  }

  /** `maxNew` caps one run so a cold start cannot flood the notification queue. */
  run(maxNew = MAX_NEW_ALERTS) {
    return this.prisma.$transaction(async (tx) => {
      const fresh = await tx.$queryRaw<Fresh[]>`
        WITH candidates AS (
          SELECT i.variant_id, i.on_hand - i.reserved AS available
          FROM inventory_items i
          JOIN product_variants v ON v.id = i.variant_id
          WHERE v.is_active
            AND i.on_hand - i.reserved <= i.reorder_level
            AND EXISTS (SELECT 1 FROM inventory_movements m WHERE m.variant_id = i.variant_id AND m.delta_on_hand > 0)
            AND NOT EXISTS (SELECT 1 FROM low_stock_alerts a WHERE a.variant_id = i.variant_id)
          ORDER BY i.on_hand - i.reserved, i.variant_id
          LIMIT ${maxNew}::int
        ), ins AS (
          INSERT INTO low_stock_alerts (variant_id, available)
          SELECT variant_id, available FROM candidates
          ON CONFLICT (variant_id) DO NOTHING
          RETURNING variant_id, available
        )
        SELECT ins.variant_id AS "variantId", v.sku, ins.available::int AS available, i.reorder_level AS "reorderLevel"
        FROM ins
        JOIN product_variants v ON v.id = ins.variant_id
        JOIN inventory_items i ON i.variant_id = ins.variant_id`;

      if (fresh.length > 0) {
        await tx.outboxEvent.createMany({
          data: fresh.map((f) => ({
            aggregateType: 'inventory',
            aggregateId: f.variantId,
            type: 'inventory.low_stock',
            payload: {
              variantId: f.variantId,
              sku: f.sku,
              available: f.available,
              reorderLevel: f.reorderLevel,
              outOfStock: f.available <= 0,
            },
          })),
        });
      }

      // Recovered (or deactivated) variants may alert again next time they drop
      const rearmed = await tx.$executeRaw`
        DELETE FROM low_stock_alerts a
        WHERE NOT EXISTS (
          SELECT 1 FROM inventory_items i JOIN product_variants v ON v.id = i.variant_id
          WHERE i.variant_id = a.variant_id AND v.is_active AND i.on_hand - i.reserved <= i.reorder_level
        )`;
      return { newAlerts: fresh.length, rearmed };
    });
  }
}
