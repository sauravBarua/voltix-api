import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JobScheduler } from './job-scheduler';
import { JOB_SCHEDULE } from './jobs.constants';
import { mismatchFingerprint } from './jobs.utils';

const LIMIT = 100;
const SAMPLE = 20;

export type StockMismatch = {
  variantId: string;
  sku: string;
  onHand: number;
  reserved: number;
  activeReserved: number;
  ledgerOnHand: number;
  ledgerReserved: number;
};

/**
 * Checks, in ONE statement (one snapshot), that the stock row, the active reservations and the ledger agree.
 * It never repairs anything: a mismatch means a bug or manual SQL, and a human decides what is true.
 */
@Injectable()
export class StockReconciliationJob implements OnModuleInit {
  private readonly logger = new Logger(StockReconciliationJob.name);

  constructor(
    private readonly scheduler: JobScheduler,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit() {
    this.scheduler.register({
      name: 'stock-reconciliation',
      ...JOB_SCHEDULE['stock-reconciliation'],
      run: () => this.run(),
    });
  }

  findMismatches() {
    return this.prisma.$queryRaw<StockMismatch[]>`
      SELECT v.id AS "variantId", v.sku,
             i.on_hand AS "onHand", i.reserved,
             COALESCE(r.q, 0) AS "activeReserved",
             COALESCE(m.on_hand_sum, 0) AS "ledgerOnHand",
             COALESCE(m.reserved_sum, 0) AS "ledgerReserved"
      FROM inventory_items i
      JOIN product_variants v ON v.id = i.variant_id
      LEFT JOIN (
        SELECT variant_id, SUM(quantity)::int AS q FROM stock_reservations WHERE status = 'ACTIVE' GROUP BY variant_id
      ) r ON r.variant_id = i.variant_id
      LEFT JOIN (
        SELECT variant_id, SUM(delta_on_hand)::int AS on_hand_sum, SUM(delta_reserved)::int AS reserved_sum
        FROM inventory_movements GROUP BY variant_id
      ) m ON m.variant_id = i.variant_id
      WHERE i.reserved <> COALESCE(r.q, 0)
         OR i.on_hand <> COALESCE(m.on_hand_sum, 0)
         OR i.reserved <> COALESCE(m.reserved_sum, 0)
      ORDER BY v.sku
      LIMIT ${LIMIT}::int`;
  }

  async run() {
    const mismatches = await this.findMismatches();
    const fingerprint = mismatchFingerprint(mismatches);

    if (mismatches.length > 0) {
      for (const m of mismatches.slice(0, SAMPLE)) {
        this.logger.error(
          `Stock mismatch ${m.sku}: on_hand=${m.onHand} ledger=${m.ledgerOnHand}, reserved=${m.reserved} reservations=${m.activeReserved} ledger=${m.ledgerReserved}`,
        );
      }
      const previous = await this.prisma.jobRun.findFirst({
        where: { job: 'stock-reconciliation', status: 'OK' },
        orderBy: { startedAt: 'desc' },
        select: { result: true },
      });
      const before = (previous?.result as { fingerprint?: string } | null)?.fingerprint;
      if (before !== fingerprint) {
        await this.prisma.outboxEvent.create({
          data: {
            aggregateType: 'inventory',
            aggregateId: 'reconciliation',
            type: 'inventory.reconciliation_mismatch',
            payload: {
              count: mismatches.length,
              variantIds: mismatches.slice(0, SAMPLE).map((m) => m.variantId),
            },
          },
          select: { id: true },
        });
      }
    }
    return {
      mismatches: mismatches.length,
      fingerprint,
      sample: mismatches.slice(0, SAMPLE).map((m) => m.sku),
    };
  }
}
