import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { z } from 'zod';
import type { Env } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * TEMPORARY (until Phase 13): identifies the shopper from an `x-user-id` header.
 * Not secure, so it is refused outright in production.
 */
@Injectable()
export class DevUserGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.config.get('NODE_ENV', { infer: true }) === 'production') {
      throw new UnauthorizedException('Authentication is not configured yet');
    }

    const req = context.switchToHttp().getRequest<Request & { userId?: string }>();
    const parsed = z.uuid().safeParse(req.header('x-user-id'));
    if (!parsed.success) throw new UnauthorizedException('Missing or invalid x-user-id header');

    const user = await this.prisma.user.findUnique({
      where: { id: parsed.data },
      select: { id: true },
    });
    if (!user) throw new UnauthorizedException('Unknown user');

    req.userId = user.id;
    return true;
  }
}
