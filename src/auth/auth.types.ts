import type { Request } from 'express';
import type { Role } from '../generated/prisma/client';

export type AuthUser = { id: string; email: string; role: Role };
export type AuthedRequest = Request & { user?: AuthUser; userId?: string };
