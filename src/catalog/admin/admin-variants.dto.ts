import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const adminVariantsQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  productId: z.uuid().optional(),
  status: z.enum(['active', 'inactive']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const adminVariantItem = z.object({
  id: z.uuid(),
  sku: z.string(),
  name: z.string(),
  attributes: z.record(z.string(), z.unknown()),
  priceMinor: z.number().int(),
  isActive: z.boolean(),
  productId: z.uuid(),
  productName: z.string(),
  productSlug: z.string(),
  productActive: z.boolean(),
  brandName: z.string(),
  onHand: z.number().int(),
  reserved: z.number().int(),
  available: z.number().int(),
  reorderLevel: z.number().int(),
});

const adminVariantList = z.object({
  items: z.array(adminVariantItem),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  totalPages: z.number().int(),
});

export class AdminVariantsQueryDto extends createZodDto(adminVariantsQuerySchema) {}
export class AdminVariantListDto extends createZodDto(adminVariantList) {}
