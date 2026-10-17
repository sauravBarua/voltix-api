import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { type Observable, mergeMap } from 'rxjs';
import { CatalogCacheService } from './catalog-cache.service';

/** After a catalog write SUCCEEDED (so it is committed), bump the cache version before replying. */
@Injectable()
export class CatalogInvalidationInterceptor implements NestInterceptor {
  constructor(private readonly cache: CatalogCacheService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.switchToHttp().getRequest<Request>().method === 'GET') return next.handle();
    return next.handle().pipe(
      mergeMap(async (value: unknown) => {
        await this.cache.bump();
        return value;
      }),
    );
  }
}
