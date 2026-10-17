import { auditTarget } from './audit.utils';

describe('auditTarget', () => {
  it('uses the first resource segment and skips the prefix and admin', () => {
    expect(auditTarget('/api/v1/admin/orders/:id/refund', { id: 'o1' }, undefined)).toEqual({
      entityType: 'orders',
      entityId: 'o1',
    });
    expect(
      auditTarget('/api/v1/inventory/variants/:variantId/stock-in', { variantId: 'v1' }, {}),
    ).toEqual({
      entityType: 'inventory',
      entityId: 'v1',
    });
  });

  it('falls back to the id of the response body, or null', () => {
    expect(auditTarget('/api/v1/categories', {}, { id: 'c1', name: 'x' })).toEqual({
      entityType: 'categories',
      entityId: 'c1',
    });
    expect(
      auditTarget('/api/v1/reservations/expire-due', {}, { expiredOrders: 0 }).entityId,
    ).toBeNull();
  });
});
