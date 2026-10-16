import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { hasAtLeastOneField } from '../../common/schemas';

const variantAttributes = z.looseObject({
  ramGb: z.number().int().positive().optional(),
  storageGb: z.number().int().positive().optional(),
  color: z.string().min(1).optional(),
});

const createVariantSchema = z.object({
  sku: z
    .string()
    .regex(
      /^[A-Z0-9][A-Z0-9._-]{2,63}$/,
      'uppercase letters, digits, dot, underscore, hyphen (3-64 chars)',
    ),
  name: z.string().trim().min(1).max(150),
  attributes: variantAttributes.optional(),
  priceMinor: z.number().int().min(0).max(100_000_000),
  reorderLevel: z.number().int().min(0).max(100_000).optional(),
  isActive: z.boolean().optional(),
});

// SKU is the identity of a variant and reorderLevel belongs to Inventory (Phase 6)
const updateVariantSchema = createVariantSchema
  .omit({ sku: true, reorderLevel: true })
  .partial()
  .refine(hasAtLeastOneField, 'At least one field is required');

export const variantResponseSchema = z.object({
  id: z.uuid(),
  sku: z.string(),
  name: z.string(),
  attributes: z.record(z.string(), z.unknown()),
  priceMinor: z.number().int(),
  currency: z.string(),
  isActive: z.boolean(),
  available: z
    .number()
    .int()
    .describe('on_hand - reserved (informational, never the stock authority)'),
});

export class CreateVariantDto extends createZodDto(createVariantSchema) {}
export class UpdateVariantDto extends createZodDto(updateVariantSchema) {}
export class VariantDto extends createZodDto(variantResponseSchema) {}
