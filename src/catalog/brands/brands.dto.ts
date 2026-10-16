import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { hasAtLeastOneField, slugSchema } from '../../common/schemas';

const createBrandSchema = z.object({
  name: z.string().trim().min(2).max(100),
  slug: slugSchema.optional(),
});

const updateBrandSchema = createBrandSchema
  .partial()
  .refine(hasAtLeastOneField, 'At least one field is required');

const brandResponse = z.object({ id: z.uuid(), name: z.string(), slug: z.string() });

export class CreateBrandDto extends createZodDto(createBrandSchema) {}
export class UpdateBrandDto extends createZodDto(updateBrandSchema) {}
export class BrandDto extends createZodDto(brandResponse) {}
