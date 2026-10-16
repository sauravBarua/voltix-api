import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { hasAtLeastOneField, slugSchema } from '../../common/schemas';

// No .default() in write DTOs: Zod 4 applies defaults inside optional fields,
// which would silently reset values on PATCH. Defaults live in the Prisma schema.
const createCategorySchema = z.object({
  name: z.string().trim().min(2).max(100),
  slug: slugSchema.optional(),
  parentId: z.uuid().optional(),
});

const updateCategorySchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    slug: slugSchema,
    parentId: z.uuid().nullable(),
  })
  .partial()
  .refine(hasAtLeastOneField, 'At least one field is required');

const categoryResponse = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  parentId: z.uuid().nullable(),
});

export class CreateCategoryDto extends createZodDto(createCategorySchema) {}
export class UpdateCategoryDto extends createZodDto(updateCategorySchema) {}
export class CategoryDto extends createZodDto(categoryResponse) {}
