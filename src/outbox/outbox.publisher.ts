import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { backoffDelayMs } from '../messaging/backoff';
import type { EventEnvelope } from '../messaging/envelope';
import { RabbitMqService } from '../messaging/rabbitmq.service';
import { PrismaService } from '../prisma/prisma.service';

const BATCH_SIZE = 50;
const POLL_INTERVAL_MS = 1_000;
const LEASE_SECONDS = 60; // a claimed row is invisible to other workers for this long
const MAX_PUBLISH_ATTEMPTS = 10;

type Claimed = {
  id: string;
  aggregateType: string;
  aggregateId: string;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
  createdAt: Date;
};

/**
 * Transactional-outbox relay (runs in the worker). Claim -> publish with confirm -> mark PUBLISHED.
 * A crash anywhere just lets the lease expire and the row is published again: at-least-once.
 */
@Injectable()
export class OutboxPublisher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisher.name);
  private stopped = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly rabbit: RabbitMqService,
  ) {}

  onModuleInit() {
    this.loop = this.run();
  }

  async onModuleDestroy() {
    this.stopped = true;
    this.wake?.();
    await this.loop; // finish the batch in flight before RabbitMQ closes
  }

  private async run() {
    while (!this.stopped) {
      let processed = 0;
      try {
        processed = await this.tick();
      } catch (error) {
        this.logger.error(
          `Outbox tick failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (processed < BATCH_SIZE) await this.sleep(POLL_INTERVAL_MS); // a full batch means more is waiting
    }
  }

  private async tick(): Promise<number> {
    if (!this.rabbit.isReady()) return 0;
    const rows = await this.claim();
    for (const row of rows) await this.publishOne(row);
    return rows.length;
  }

  /**
   * One statement: pick due rows (skipping rows other workers hold), count the attempt and push
   * available_at out by the lease. If this worker dies, the row becomes due again after the lease.
   */
  private async claim(): Promise<Claimed[]> {
    const rows = await this.prisma.$queryRaw<Claimed[]>`
      UPDATE outbox_events
      SET attempts = attempts + 1,
          available_at = now() + ${LEASE_SECONDS}::int * interval '1 second'
      WHERE id IN (
        SELECT id FROM outbox_events
        WHERE status = 'PENDING' AND available_at <= now()
        ORDER BY created_at
        LIMIT ${BATCH_SIZE}::int
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, aggregate_type AS "aggregateType", aggregate_id AS "aggregateId", type, payload,
                attempts, created_at AS "createdAt"`;
    return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  private async publishOne(row: Claimed) {
    try {
      const envelope: EventEnvelope = {
        id: row.id,
        type: row.type,
        aggregateType: row.aggregateType,
        aggregateId: row.aggregateId,
        occurredAt: row.createdAt.toISOString(),
        payload: row.payload,
      };
      await this.rabbit.publishEvent({
        messageId: row.id,
        routingKey: row.type,
        type: row.type,
        body: Buffer.from(JSON.stringify(envelope)),
      });
      await this.prisma.outboxEvent.updateMany({
        where: { id: row.id, status: 'PENDING' },
        data: { status: 'PUBLISHED', publishedAt: new Date(), lastError: null },
      });
    } catch (error) {
      await this.markFailure(row, error);
    }
  }

  private async markFailure(row: Claimed, error: unknown) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    const exhausted = row.attempts >= MAX_PUBLISH_ATTEMPTS;
    try {
      await this.prisma.outboxEvent.updateMany({
        where: { id: row.id, status: 'PENDING' },
        data: exhausted
          ? { status: 'FAILED', lastError: message }
          : {
              lastError: message,
              availableAt: new Date(Date.now() + backoffDelayMs(row.attempts)),
            },
      });
      if (exhausted) {
        this.logger.error(
          `Outbox event ${row.id} (${row.type}) FAILED after ${row.attempts} attempts: ${message}`,
        );
      } else {
        this.logger.warn(
          `Outbox event ${row.id} (${row.type}) not published (attempt ${row.attempts}): ${message}`,
        );
      }
    } catch (dbError) {
      // The lease expires on its own and the row is retried
      this.logger.error(
        `Could not record the failure of outbox event ${row.id}: ${dbError instanceof Error ? dbError.message : String(dbError)}`,
      );
    }
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
