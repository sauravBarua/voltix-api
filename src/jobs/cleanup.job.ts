import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { JobScheduler } from './job-scheduler';
import { JOB_SCHEDULE } from './jobs.constants';
import { daysAgo } from './jobs.utils';

const BATCH = 5_000;
const MAX_BATCHES = 20;

const RETENTION_DAYS = {
  outboxPublished: 7,
  processedMessages: 14,
  webhookEvents: 30,
  refreshTokensAfterExpiry: 7, // revoked tokens stay until they expire: reuse detection needs them
  jobRuns: 30,
} as const;

const iso = (days: number) => daysAgo(days).toISOString();

/** Keeps the operational tables from growing forever. PENDING and FAILED outbox rows are never deleted. */
@Injectable()
export class CleanupJob implements OnModuleInit {
  private readonly auditRetentionDays: number;

  constructor(
    private readonly scheduler: JobScheduler,
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.auditRetentionDays = config.get('AUDIT_RETENTION_DAYS', { infer: true });
  }

  onModuleInit() {
    this.scheduler.register({ name: 'cleanup', ...JOB_SCHEDULE.cleanup, run: () => this.run() });
  }

  async run() {
    const outbox = await this.purge(
      () => this.prisma.$executeRaw`
        DELETE FROM outbox_events WHERE id IN (
          SELECT id FROM outbox_events
          WHERE status = 'PUBLISHED' AND published_at < ${iso(RETENTION_DAYS.outboxPublished)}::timestamptz
          LIMIT ${BATCH}::int)`,
    );
    const processedMessages = await this.purge(
      () => this.prisma.$executeRaw`
        DELETE FROM processed_messages WHERE id IN (
          SELECT id FROM processed_messages
          WHERE processed_at < ${iso(RETENTION_DAYS.processedMessages)}::timestamptz
          LIMIT ${BATCH}::int)`,
    );
    const webhookEvents = await this.purge(
      () => this.prisma.$executeRaw`
        DELETE FROM stripe_webhook_events WHERE id IN (
          SELECT id FROM stripe_webhook_events
          WHERE received_at < ${iso(RETENTION_DAYS.webhookEvents)}::timestamptz
          LIMIT ${BATCH}::int)`,
    );
    const refreshTokens = await this.purge(
      () => this.prisma.$executeRaw`
        DELETE FROM refresh_tokens WHERE id IN (
          SELECT id FROM refresh_tokens
          WHERE expires_at < ${iso(RETENTION_DAYS.refreshTokensAfterExpiry)}::timestamptz
          LIMIT ${BATCH}::int)`,
    );
    const jobRuns = await this.purge(
      () => this.prisma.$executeRaw`
        DELETE FROM job_runs WHERE id IN (
          SELECT id FROM job_runs
          WHERE started_at < ${iso(RETENTION_DAYS.jobRuns)}::timestamptz
          LIMIT ${BATCH}::int)`,
    );
    const auditCutoff = iso(this.auditRetentionDays);
    const auditLogs = await this.purge(() =>
      this.prisma.$transaction(async (tx) => {
        // Local to this transaction: lets the append-only trigger accept DELETE, nothing else
        await tx.$queryRaw`SELECT set_config('voltix.audit_purge', 'on', true)`;
        return tx.$executeRaw`
          DELETE FROM audit_logs WHERE id IN (
            SELECT id FROM audit_logs WHERE created_at < ${auditCutoff}::timestamptz LIMIT ${BATCH}::int)`;
      }),
    );
    return { outbox, processedMessages, webhookEvents, refreshTokens, jobRuns, auditLogs };
  }

  /** Repeats a batched delete until a batch comes back short (bounded, so one run cannot hog the database). */
  private async purge(deleteBatch: () => Promise<number>): Promise<number> {
    let total = 0;
    for (let i = 0; i < MAX_BATCHES; i++) {
      const deleted = await deleteBatch();
      total += deleted;
      if (deleted < BATCH) break;
    }
    return total;
  }
}
