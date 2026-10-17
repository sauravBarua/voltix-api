import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { AuthUser, AuthedRequest } from '../../auth/auth.types';

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthUser =>
    context.switchToHttp().getRequest<AuthedRequest>().user as AuthUser,
);
