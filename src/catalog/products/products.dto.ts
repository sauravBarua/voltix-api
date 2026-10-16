import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { slugSchema } from '../../common/schemas';
import { variantResponseSchema } from '../variants/variants.dto';

export const createProductSchema = z.object({
  name: z.string().trim().min(2).max(200),
  slug: slugSchema.optional(),
  description: z.string().max(5000).optional(),
  brandId: z.uuid(),
  categoryId: z.uuid(),
  specs: z.record(z.string(), z.unknown()).describe('Validated against the category specs schema'),
  warrantyMonths: z.number().int().min(0).max(120).optional(),
  isActive: z.boolean().optional(),
});

export const updateProductSchema = createProductSchema.partial().extend({
  removeImageIds: z.array(z.uuid()).max(20).optional().describe('Product images to delete'),
  primaryImageId: z.uuid().optional().describe('Existing image to make primary'),
});

const listProductsSchema = z
  .object({
    q: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe('Matches product name, brand name or SKU'),
    brand: z.string().max(200).optional().describe('Comma-separated brand slugs'),
    category: slugSchema.optional().describe('Category slug (includes its children)'),
    minPrice: z.coerce.number().int().min(0).optional().describe('Minor units (cents)'),
    maxPrice: z.coerce.number().int().min(0).optional().describe('Minor units (cents)'),
    specs: z.string().max(1000).optional().describe('URL-encoded flat JSON, e.g. {"os":"macOS"}'),
    attributes: z
      .string()
      .max(1000)
      .optional()
      .describe('URL-encoded flat JSON, e.g. {"ramGb":16}'),
    sort: z.enum(['newest', 'name_asc', 'name_desc', 'price_asc', 'price_desc']).default('newest'),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .refine((q) => q.minPrice === undefined || q.maxPrice === undefined || q.minPrice <= q.maxPrice, {
    message: 'minPrice must be <= maxPrice',
    path: ['maxPrice'],
  });

const ref = z.object({ id: z.uuid(), name: z.string(), slug: z.string() });

const productSummary = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  brand: ref,
  category: ref,
  imageUrl: z.string().nullable(),
  priceFromMinor: z.number().int().nullable(),
  currency: z.string().nullable(),
  inStock: z.boolean(),
});

const productDetail = productSummary.extend({
  description: z.string(),
  specs: z.record(z.string(), z.unknown()),
  warrantyMonths: z.number().int(),
  images: z.array(
    z.object({
      id: z.uuid(),
      url: z.string(),
      isPrimary: z.boolean(),
      variantId: z.uuid().nullable(),
    }),
  ),
  variants: z.array(variantResponseSchema),
});

const productList = z.object({
  items: z.array(productSummary),
  meta: z.object({
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
    totalPages: z.number().int(),
  }),
});

export class CreateProductDto extends createZodDto(createProductSchema) {}
/** Plain types (not ZodDto classes) so the global ZodValidationPipe skips the raw multipart `data` string. */
export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export class UpdateProductDto extends createZodDto(updateProductSchema) {}
export class ListProductsDto extends createZodDto(listProductsSchema) {}
export class ProductDetailDto extends createZodDto(productDetail) {}
export class ProductListDto extends createZodDto(productList) {}
export class ProductImageParamDto extends createZodDto(
  z.object({ id: z.uuid(), imageId: z.uuid() }),
) {}
