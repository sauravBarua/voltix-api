import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const run = z.object({
  status: z.string().describe('RUNNING, OK or FAILED'),
  instance: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  result: z.record(z.string(), z.unknown()),
  error: z.string().nullable(),
});

const job = z.object({
  name: z.string(),
  intervalSeconds: z.number().int(),
  healthy: z.boolean().describe('Last success is younger than three intervals'),
  running: z.boolean(),
  lastSuccessAt: z.string().nullable(),
  lastRun: run.nullable(),
});

export class JobsStatusDto extends createZodDto(
  z.object({ healthy: z.boolean().describe('Every job is healthy'), jobs: z.array(job) }),
) {}
