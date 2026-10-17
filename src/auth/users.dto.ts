import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ROLES, emailSchema, passwordSchema, userViewSchema } from './auth.dto';

const createUserSchema = z.object({
  email: emailSchema,
  name: z.string().trim().min(2).max(100),
  password: passwordSchema.describe(
    'Initial password: hand it over securely and ask the user to change it',
  ),
  role: z.enum(ROLES),
});

const updateUserSchema = z
  .object({ role: z.enum(ROLES), isActive: z.boolean() })
  .partial()
  .refine(
    (o) => o.role !== undefined || o.isActive !== undefined,
    'At least one field is required',
  );

const listUsersSchema = z.object({
  q: z.string().trim().min(1).max(100).optional().describe('Matches email or name'),
  role: z.enum(ROLES).optional(),
  isActive: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export class CreateUserDto extends createZodDto(createUserSchema) {}
export class UpdateUserDto extends createZodDto(updateUserSchema) {}
export class ListUsersDto extends createZodDto(listUsersSchema) {}
export class UserListDto extends createZodDto(
  z.object({
    items: z.array(userViewSchema),
    meta: z.object({
      page: z.number().int(),
      pageSize: z.number().int(),
      total: z.number().int(),
      totalPages: z.number().int(),
    }),
  }),
) {}
