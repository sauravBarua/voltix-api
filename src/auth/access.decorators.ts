import { SetMetadata, applyDecorators } from '@nestjs/common';
import { ApiBearerAuth, ApiForbiddenResponse, ApiUnauthorizedResponse } from '@nestjs/swagger';
import type { Role } from '../generated/prisma/client';

export const ACCESS_KEY = 'access';
export const SKIP_AUDIT_KEY = 'skipAudit';
export type Access = 'public' | readonly Role[];
export const ALL_ROLES: Role[] = ['CUSTOMER', 'INVENTORY_OPERATOR', 'ADMIN'];

/** No authentication. Use sparingly: health, public catalog reads, auth entry points, the Stripe webhook. */
export const Public = () => SetMetadata(ACCESS_KEY, 'public');

/** Logged-in user with one of these roles. A handler-level policy overrides the class-level one. */
export const Roles = (...roles: Role[]) =>
  applyDecorators(
    SetMetadata(ACCESS_KEY, roles),
    ApiBearerAuth(),
    ApiUnauthorizedResponse({ description: 'Missing, invalid or expired access token' }),
    ApiForbiddenResponse({ description: 'Your role cannot access this resource' }),
  );

/** Any logged-in user. */
export const Authenticated = () => Roles(...ALL_ROLES);

/** The handler writes its own, richer audit entry. */
export const SkipAudit = () => SetMetadata(SKIP_AUDIT_KEY, true);
