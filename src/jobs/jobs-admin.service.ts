import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JOB_NAMES, JOB_SCHEDULE } from './jobs.constants';
import { isHealthy } from './jobs.utils';

@Injectable()
export class JobsAdminService {
  constructor(private readonly prisma: PrismaService) {}

  async status() {
    const now = Date.now();
    const jobs = await Promise.all(
      JOB_NAMES.map(async (name) => {
        const [last, lastOk, lock] = await Promise.all([
          this.prisma.jobRun.findFirst({ where: { job: name }, orderBy: { startedAt: 'desc' } }),
          this.prisma.jobRun.findFirst({
            where: { job: name, status: 'OK' },
            orderBy: { startedAt: 'desc' },
            select: { finishedAt: true },
          }),
          this.prisma.jobLock.findUnique({ where: { name } }),
        ]);
        const { intervalMs } = JOB_SCHEDULE[name];
        const lastSuccessAt = lastOk?.finishedAt ?? null;
        return {
          name,
          intervalSeconds: Math.round(intervalMs / 1000),
          healthy: isHealthy(lastSuccessAt, intervalMs, now),
          running: lock !== null && lock.lockedUntil.getTime() > now,
          lastSuccessAt: lastSuccessAt?.toISOString() ?? null,
          lastRun: last
            ? {
                status: last.status,
                instance: last.instance,
                startedAt: last.startedAt.toISOString(),
                finishedAt: last.finishedAt?.toISOString() ?? null,
                durationMs: last.finishedAt
                  ? last.finishedAt.getTime() - last.startedAt.getTime()
                  : null,
                result: last.result as Record<string, unknown>,
                error: last.error,
              }
            : null,
        };
      }),
    );
    return { healthy: jobs.every((j) => j.healthy), jobs };
  }
}
