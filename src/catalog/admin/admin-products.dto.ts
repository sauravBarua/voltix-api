import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const adminProductsQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  categoryId: z.uuid().optional(),
  status: z.enum(['active', 'draft']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const ref = z.object({ id: z.uuid(), name: z.string() });
const categoryRef = ref.extend({ slug: z.string() });

const adminProductItem = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  isActive: z.boolean(),
  brand: ref,
  category: categoryRef,
  imageUrl: z.string().nullable(),
  variantCount: z.number().int(),
  activeVariantCount: z.number().int(),
  priceFromMinor: z.number().int().nullable(),
  priceToMinor: z.number().int().nullable(),
  available: z.number().int(),
});

const adminProductList = z.object({
  items: z.array(adminProductItem),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  totalPages: z.number().int(),
});

const adminProductDetail = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  description: z.string(),
  specs: z.record(z.string(), z.unknown()),
  warrantyMonths: z.number().int(),
  isActive: z.boolean(),
  brand: ref,
  category: categoryRef.extend({ parentId: z.uuid().nullable() }),
  images: z.array(
    z.object({
      id: z.uuid(),
      url: z.string(),
      isPrimary: z.boolean(),
      variantId: z.uuid().nullable(),
    }),
  ),
  variants: z.array(
    z.object({
      id: z.uuid(),
      sku: z.string(),
      name: z.string(),
      attributes: z.record(z.string(), z.unknown()),
      priceMinor: z.number().int(),
      isActive: z.boolean(),
      onHand: z.number().int(),
      reserved: z.number().int(),
      available: z.number().int(),
    }),
  ),
});

export class AdminProductsQueryDto extends createZodDto(adminProductsQuerySchema) {}
export class AdminProductListDto extends createZodDto(adminProductList) {}
export class AdminProductDetailDto extends createZodDto(adminProductDetail) {}
