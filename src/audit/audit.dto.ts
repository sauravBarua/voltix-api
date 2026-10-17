import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const listAuditSchema = z
  .object({
    actorId: z.uuid().optional(),
    action: z.string().trim().min(1).max(200).optional().describe('Exact action, e.g. auth.login'),
    entityType: z.string().trim().min(1).max(100).optional(),
    entityId: z.string().trim().min(1).max(100).optional(),
    outcome: z.enum(['SUCCESS', 'FAILURE']).optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .refine((q) => !q.from || !q.to || new Date(q.from) <= new Date(q.to), {
    message: 'from must be <= to',
    path: ['to'],
  });

const entry = z.object({
  id: z.uuid(),
  actorId: z.uuid().nullable(),
  actorEmail: z.string().nullable(),
  actorRole: z.string().nullable(),
  action: z.string(),
  entityType: z.string().nullable(),
  entityId: z.string().nullable(),
  outcome: z.string(),
  ip: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});

export class ListAuditDto extends createZodDto(listAuditSchema) {}
export class AuditListDto extends createZodDto(
  z.object({
    items: z.array(entry),
    meta: z.object({
      page: z.number().int(),
      pageSize: z.number().int(),
      total: z.number().int(),
      totalPages: z.number().int(),
    }),
  }),
) {}
