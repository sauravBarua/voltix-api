import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const RESERVATION_STATUSES = ['ACTIVE', 'CONSUMED', 'RELEASED', 'EXPIRED'] as const;

const listReservationsSchema = z.object({
  status: z.enum(RESERVATION_STATUSES).optional(),
  orderId: z.uuid().optional(),
  variantId: z.uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const reservation = z.object({
  id: z.uuid(),
  orderId: z.uuid(),
  variantId: z.uuid(),
  sku: z.string(),
  quantity: z.number().int(),
  status: z.enum(RESERVATION_STATUSES),
  expiresAt: z.string(),
  resolvedAt: z.string().nullable(),
  createdAt: z.string(),
});

const reservationList = z.object({
  items: z.array(reservation),
  meta: z.object({
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
    totalPages: z.number().int(),
  }),
});

const expireResult = z.object({
  expiredOrders: z.number().int().describe('Orders whose reservations were expired by this run'),
  failedOrders: z.number().int().describe('Orders that failed and will be retried on the next run'),
});

export class ListReservationsDto extends createZodDto(listReservationsSchema) {}
export class ReservationListDto extends createZodDto(reservationList) {}
export class ExpireResultDto extends createZodDto(expireResult) {}
