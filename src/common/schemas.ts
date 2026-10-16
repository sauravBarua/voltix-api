import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const slugSchema = z
  .string()
  .min(2)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lowercase letters, digits and hyphens only');

/** PATCH bodies must change something. */
export const hasAtLeastOneField = (o: Record<string, unknown>) =>
  Object.values(o).some((v) => v !== undefined);

export class IdParamDto extends createZodDto(z.object({ id: z.uuid() })) {}
export class SlugParamDto extends createZodDto(z.object({ slug: slugSchema })) {}
