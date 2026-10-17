import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Observable, mergeMap } from 'rxjs';
import { SKIP_AUDIT_KEY } from '../auth/access.decorators';
import type { AuthedRequest } from '../auth/auth.types';
import { auditTarget } from './audit.utils';
import { AuditService } from './audit.service';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const STAFF = new Set(['ADMIN', 'INVENTORY_OPERATOR']);

/** Records every SUCCESSFUL write made by a staff role. Never stores request bodies (they can hold secrets). */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly audit: AuditService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const skip = this.reflector.getAllAndOverride<boolean | undefined>(SKIP_AUDIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (SAFE_METHODS.has(req.method) || skip) return next.handle();

    return next.handle().pipe(
      mergeMap(async (body: unknown) => {
        const user = req.user;
        if (user && STAFF.has(user.role)) {
          const routePath = (req.route as { path?: unknown } | undefined)?.path;
          const path = typeof routePath === 'string' ? routePath : req.path;
          await this.audit.record({
            actorId: user.id,
            actorEmail: user.email,
            actorRole: user.role,
            action: `${req.method} ${path}`,
            ...auditTarget(path, req.params as Record<string, string | undefined>, body),
            ip: req.ip,
          });
        }
        return body;
      }),
    );
  }
}
