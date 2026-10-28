import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const refundSchema = z.object({
  amountMinor: z
    .number()
    .int()
    .min(1)
    .max(99_999_999)
    .optional()
    .describe('Omit to refund the whole remaining amount'),
  restock: z
    .boolean()
    .describe(
      'true = the items came back in good condition and return to stock (full refund only)',
    ),
  reason: z.string().trim().min(3).max(200),
});

const payResult = z.object({
  paymentId: z.uuid(),
  sessionId: z.string(),
  url: z.string().describe('Redirect the customer here (Stripe Checkout)'),
  expiresAt: z.string(),
});

const refundResult = z.object({
  stripeRefundId: z.string(),
  status: z
    .string()
    .nullable()
    .describe('Stripe refund status; the order updates when the webhook confirms'),
  amountMinor: z.number().int(),
  restock: z.boolean(),
  full: z.boolean(),
  note: z.string(),
});

const syncResult = z.object({
  orderId: z.uuid(),
  orderNumber: z.string(),
  status: z.string().describe('Order status after the sync'),
  paymentStatus: z.enum(['paid', 'unpaid']).describe('What Stripe says about the Checkout Session'),
});

export class RefundDto extends createZodDto(refundSchema) {}
export class PayResultDto extends createZodDto(payResult) {}
export class RefundResultDto extends createZodDto(refundResult) {}
export class SyncPaymentResultDto extends createZodDto(syncResult) {}
