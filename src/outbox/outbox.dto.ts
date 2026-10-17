import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const STATUSES = ['PENDING', 'PUBLISHED', 'FAILED'] as const;

const listOutboxSchema = z.object({
  status: z.enum(STATUSES).optional(),
  type: z.string().trim().min(1).max(100).optional().describe('Exact event type, e.g. order.paid'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const outboxEvent = z.object({
  id: z.uuid(),
  aggregateType: z.string(),
  aggregateId: z.string(),
  type: z.string(),
  status: z.enum(STATUSES),
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  availableAt: z.string(),
  publishedAt: z.string().nullable(),
  createdAt: z.string(),
  payload: z.record(z.string(), z.unknown()),
});

const summary = z.object({
  pending: z.number().int(),
  published: z.number().int(),
  failed: z.number().int(),
  oldestPendingAgeSeconds: z
    .number()
    .int()
    .nullable()
    .describe('Publishing lag: age of the oldest unpublished event'),
});

export class ListOutboxDto extends createZodDto(listOutboxSchema) {}
export class OutboxEventDto extends createZodDto(outboxEvent) {}
export class OutboxSummaryDto extends createZodDto(summary) {}
export class OutboxListDto extends createZodDto(
  z.object({
    items: z.array(outboxEvent),
    meta: z.object({
      page: z.number().int(),
      pageSize: z.number().int(),
      total: z.number().int(),
      totalPages: z.number().int(),
    }),
  }),
) {}
