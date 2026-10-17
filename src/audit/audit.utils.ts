const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Which entity a write touched: type from the route, id from the path parameters or the response. */
export function auditTarget(
  routePath: string,
  params: Record<string, string | undefined>,
  body: unknown,
): { entityType: string | null; entityId: string | null } {
  const segments = routePath
    .split('/')
    .filter((s) => s && s !== 'api' && s !== 'admin' && !/^v\d+$/.test(s) && !s.startsWith(':'));
  const bodyId = isRecord(body) && typeof body.id === 'string' ? body.id : null;
  return { entityType: segments[0] ?? null, entityId: params.id ?? params.variantId ?? bodyId };
}
