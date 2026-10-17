import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const MOVEMENT_TYPES = [
  'STOCK_IN',
  'STOCK_OUT',
  'ADJUSTMENT',
  'RESERVE',
  'RELEASE',
  'SALE',
  'RETURN',
] as const;

const quantity = z.number().int().min(1).max(1_000_000);
const reason = z.string().trim().min(3).max(500);
const idempotencyKey = z
  .string()
  .trim()
  .min(8)
  .max(100)
  .optional()
  .describe(
    'Replaying the same key for the same variant and operation returns the original result',
  );

// No .default() in write DTOs (see Phase 4 note)
const stockInSchema = z.object({
  quantity,
  reason: reason.optional(),
  idempotencyKey,
});

const stockOutSchema = z.object({ quantity, reason, idempotencyKey });

const adjustmentSchema = z.object({
  delta: z
    .number()
    .int()
    .min(-1_000_000)
    .max(1_000_000)
    .refine((d) => d !== 0, 'delta must not be 0')
    .describe('Signed change to on-hand units (use a negative number for shrinkage)'),
  reason,
  idempotencyKey,
});

const reorderLevelSchema = z.object({ reorderLevel: z.number().int().min(0).max(100_000) });

const listInventorySchema = z.object({
  q: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe('Matches SKU, variant name or product name'),
  status: z
    .enum(['all', 'low', 'out'])
    .default('all')
    .describe('low = available <= reorder level (includes out)'),
  includeInactive: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const listMovementsSchema = z
  .object({
    variantId: z.uuid().optional(),
    type: z.enum(MOVEMENT_TYPES).optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .refine((q) => !q.from || !q.to || new Date(q.from) <= new Date(q.to), {
    message: 'from must be <= to',
    path: ['to'],
  });

const meta = z.object({
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
  totalPages: z.number().int(),
});

const snapshot = z.object({
  variantId: z.uuid(),
  onHand: z.number().int(),
  reserved: z.number().int(),
  available: z.number().int().describe('onHand - reserved'),
  reorderLevel: z.number().int(),
});

const item = snapshot.extend({
  sku: z.string(),
  variantName: z.string(),
  productName: z.string(),
  isActive: z.boolean(),
  priceMinor: z.number().int(),
  lowStock: z.boolean(),
});

const movement = z.object({
  id: z.uuid(),
  variantId: z.uuid(),
  sku: z.string(),
  type: z.enum(MOVEMENT_TYPES),
  deltaOnHand: z.number().int(),
  deltaReserved: z.number().int(),
  reason: z.string().nullable(),
  referenceType: z.string().nullable(),
  referenceId: z.string().nullable(),
  actorId: z.uuid().nullable(),
  createdAt: z.string(),
});

export class VariantIdParamDto extends createZodDto(z.object({ variantId: z.uuid() })) {}
export class StockInDto extends createZodDto(stockInSchema) {}
export class StockOutDto extends createZodDto(stockOutSchema) {}
export class AdjustmentDto extends createZodDto(adjustmentSchema) {}
export class ReorderLevelDto extends createZodDto(reorderLevelSchema) {}
export class ListInventoryDto extends createZodDto(listInventorySchema) {}
export class ListMovementsDto extends createZodDto(listMovementsSchema) {}

export class InventoryItemDto extends createZodDto(item) {}
export class InventoryListDto extends createZodDto(z.object({ items: z.array(item), meta })) {}
export class MovementListDto extends createZodDto(z.object({ items: z.array(movement), meta })) {}
export class StockMutationDto extends createZodDto(
  z.object({ replayed: z.boolean(), movement, stock: snapshot }),
) {}
