import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const ORDER_STATUSES = [
  'PENDING_PAYMENT',
  'PAID',
  'SHIPPED',
  'CANCELLED',
  'PAYMENT_FAILED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
] as const;

const shippingAddress = z.object({
  fullName: z.string().trim().min(2).max(100),
  line1: z.string().trim().min(3).max(150),
  line2: z.string().trim().max(150).optional(),
  city: z.string().trim().min(2).max(100),
  postalCode: z.string().trim().min(3).max(12),
  country: z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2 code in uppercase, e.g. FR'),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ()-]{6,20}$/, 'invalid phone number')
    .optional(),
});

const checkoutSchema = z.object({ shippingAddress });

const listOrdersSchema = z.object({
  status: z.enum(ORDER_STATUSES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const adminListOrdersSchema = listOrdersSchema.extend({
  userId: z.uuid().optional(),
  q: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe('Matches order number or customer email'),
});

const orderItem = z.object({
  variantId: z.uuid(),
  sku: z.string(),
  name: z.string(),
  unitPriceMinor: z.number().int(),
  quantity: z.number().int(),
  lineTotalMinor: z.number().int(),
});

const order = z.object({
  id: z.uuid(),
  orderNumber: z.string(),
  status: z.enum(ORDER_STATUSES),
  items: z.array(orderItem),
  subtotalMinor: z.number().int(),
  shippingMinor: z.number().int(),
  totalMinor: z.number().int(),
  currency: z.string(),
  shippingAddress: z.record(z.string(), z.unknown()),
  expiresAt: z
    .string()
    .nullable()
    .describe('Payment deadline while PENDING_PAYMENT, otherwise null'),
  cancelReason: z.string().nullable(),
  paidAt: z.string().nullable(),
  shippedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  createdAt: z.string(),
});

const adminOrder = order.extend({
  customer: z.object({ id: z.uuid(), email: z.string(), name: z.string() }),
});

const meta = z.object({
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
  totalPages: z.number().int(),
});

export class CheckoutDto extends createZodDto(checkoutSchema) {}
export class ListOrdersDto extends createZodDto(listOrdersSchema) {}
export class AdminListOrdersDto extends createZodDto(adminListOrdersSchema) {}

export class OrderDto extends createZodDto(order) {}
export class OrderListDto extends createZodDto(z.object({ items: z.array(order), meta })) {}
export class CheckoutResultDto extends createZodDto(z.object({ replayed: z.boolean(), order })) {}
export class AdminOrderDto extends createZodDto(adminOrder) {}
export class AdminOrderListDto extends createZodDto(
  z.object({ items: z.array(adminOrder), meta }),
) {}
