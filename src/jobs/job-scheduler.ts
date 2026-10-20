import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JOBS_OPTIONS, type JobsOptions } from './jobs.constants';
import { randomBetween } from './jobs.utils';

export type JobResult = Prisma.InputJsonObject;

export interface JobDefinition {
  name: string;
  intervalMs: number;
  leaseSeconds: number;
  run: () => Promise<JobResult>;
}

export type JobOutcome =
  { status: 'ok'; result: JobResult } | { status: 'skipped' } | { status: 'failed'; error: string };

/**
 * Runs each registered job on its interval. Before every run the worker takes a lease row, so with
 * several workers (or a restart overlapping a run) only one executes a given job at a time.
 */
@Injectable()
export class JobScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(JobScheduler.name);
  private readonly jobs = new Map<string, JobDefinition>();
  private readonly instance = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  private readonly wakers = new Set<() => void>();
  private readonly loops: Promise<void>[] = [];
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(JOBS_OPTIONS) private readonly options: JobsOptions,
  ) {}

  register(def: JobDefinition) {
    if (this.jobs.has(def.name)) throw new Error(`Job ${def.name} is already registered`);
    this.jobs.set(def.name, def);
  }

  onApplicationBootstrap() {
    if (!this.options.autoStart) {
      this.logger.log('Job scheduler is off (NODE_ENV=test or JOBS_ENABLED=false)');
      return;
    }
    for (const def of this.jobs.values()) this.loops.push(this.loop(def));
    this.logger.log(`Scheduler started: ${[...this.jobs.keys()].join(', ')}`);
  }

  /** Waits for jobs mid-run, so a shutdown does not cut one in half. */
  async onModuleDestroy() {
    this.stopped = true;
    for (const wake of this.wakers) wake();
    await Promise.all(this.loops);
  }

  /** Runs one job now, with the same lease and run log as the schedule. Used by tests and operations. */
  runNow(name: string): Promise<JobOutcome> {
    const def = this.jobs.get(name);
    if (!def) throw new Error(`Unknown job ${name}`);
    return this.runOnce(def);
  }

  private async loop(def: JobDefinition) {
    await this.sleep(randomBetween(1_000, 15_000)); // stagger the first runs
    while (!this.stopped) {
      try {
        await this.runOnce(def);
      } catch (error) {
        this.logger.error(
          `Job ${def.name} could not run: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await this.sleep(Math.round(def.intervalMs * (0.9 + Math.random() * 0.2)));
    }
  }

  private async runOnce(def: JobDefinition): Promise<JobOutcome> {
    if (!(await this.acquire(def))) return { status: 'skipped' };

    const run = await this.prisma.jobRun.create({
      data: { job: def.name, instance: this.instance },
      select: { id: true },
    });
    try {
      const result = await def.run();
      await this.prisma.jobRun.update({
        where: { id: run.id },
        data: { status: 'OK', finishedAt: new Date(), result },
      });
      return { status: 'ok', result };
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
      this.logger.error(`Job ${def.name} failed: ${message}`);
      await this.prisma.jobRun
        .update({
          where: { id: run.id },
          data: { status: 'FAILED', finishedAt: new Date(), error: message },
        })
        .catch(() => undefined);
      return { status: 'failed', error: message };
    } finally {
      await this.release(def).catch(() => undefined); // an unreleased lease simply expires
    }
  }

  /** One statement: take the lease only if nobody holds an unexpired one. */
  private async acquire(def: JobDefinition): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ name: string }[]>`
      INSERT INTO job_locks (name, locked_until, locked_by)
      VALUES (${def.name}, now() + ${def.leaseSeconds}::int * interval '1 second', ${this.instance})
      ON CONFLICT (name) DO UPDATE
        SET locked_until = EXCLUDED.locked_until, locked_by = EXCLUDED.locked_by
        WHERE job_locks.locked_until < now()
      RETURNING name`;
    return rows.length > 0;
  }

  private release(def: JobDefinition) {
    return this.prisma.$executeRaw`
      UPDATE job_locks SET locked_until = now() WHERE name = ${def.name} AND locked_by = ${this.instance}`;
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wakers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wakers.add(done);
    });
  }
}
