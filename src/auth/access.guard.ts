import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { ACCESS_KEY, type Access } from './access.decorators';
import type { AuthedRequest } from './auth.types';
import { TokensService } from './tokens.service';

export const bearerToken = (header: string | undefined): string | null =>
  /^Bearer\s+(\S+)$/i.exec(header ?? '')?.[1] ?? null;

/**
 * Global guard. Default deny: a handler without an explicit policy is refused.
 * The role and active flag come from the database, so a change applies to the very next request.
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokensService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const access = this.reflector.getAllAndOverride<Access | undefined>(ACCESS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (access === 'public') return true;
    if (!access) throw new ForbiddenException('This route has no access policy');

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const token = bearerToken(req.headers.authorization);
    if (!token) throw new UnauthorizedException('Missing bearer token');

    const userId = await this.tokens.verifyAccess(token);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, role: true, isActive: true },
    });
    if (!user?.isActive) throw new UnauthorizedException('Invalid or expired token');

    if (!access.includes(user.role)) {
      await this.audit.record({
        actorId: user.id,
        actorEmail: user.email,
        actorRole: user.role,
        action: 'access.denied',
        outcome: 'FAILURE',
        ip: req.ip,
        metadata: { method: req.method, path: req.path },
      });
      throw new ForbiddenException('Your role cannot access this resource');
    }

    req.user = { id: user.id, email: user.email, role: user.role };
    req.userId = user.id;
    return true;
  }
}
