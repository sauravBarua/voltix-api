import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const ROLES = ['CUSTOMER', 'INVENTORY_OPERATOR', 'ADMIN'] as const;

export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const passwordSchema = z.string().min(10, 'at least 10 characters').max(128);

const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().min(2).max(100),
});
const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(128) });
const refreshSchema = z.object({ refreshToken: z.string().min(20).max(200) });
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});

export const userViewSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  name: z.string(),
  role: z.enum(ROLES),
  isActive: z.boolean(),
  createdAt: z.string(),
});

const tokensSchema = z.object({
  tokenType: z.literal('Bearer'),
  accessToken: z.string(),
  expiresIn: z.number().int().describe('Access token lifetime in seconds'),
  refreshToken: z.string().describe('Single use: every refresh returns a new one'),
  user: userViewSchema,
});

export class RegisterDto extends createZodDto(registerSchema) {}
export class LoginDto extends createZodDto(loginSchema) {}
export class RefreshDto extends createZodDto(refreshSchema) {}
export class ChangePasswordDto extends createZodDto(changePasswordSchema) {}
export class UserDto extends createZodDto(userViewSchema) {}
export class AuthTokensDto extends createZodDto(tokensSchema) {}
