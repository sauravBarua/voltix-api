import { ExecutionContext, createParamDecorator } from '@nestjs/common';

/** Id of the authenticated user (set by the guard). Phase 13 keeps this decorator as is. */
export const CurrentUserId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    return context.switchToHttp().getRequest<{ userId: string }>().userId;
  },
);
