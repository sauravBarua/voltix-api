import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { MAX_QTY_PER_LINE } from './cart.constants';

const quantity = z.number().int().min(1).max(MAX_QTY_PER_LINE);

const addItemSchema = z.object({ variantId: z.uuid(), quantity });
const setQuantitySchema = z.object({
  quantity: quantity.describe('New total quantity of the line'),
});

const line = z.object({
  variantId: z.uuid(),
  sku: z.string(),
  productName: z.string(),
  productSlug: z.string(),
  variantName: z.string(),
  imageUrl: z.string().nullable(),
  unitPriceMinor: z.number().int(),
  currency: z.string(),
  quantity: z.number().int(),
  lineTotalMinor: z.number().int(),
  available: z.number().int().describe('Advisory only, never the stock authority'),
  status: z.enum(['OK', 'INSUFFICIENT_STOCK', 'UNAVAILABLE']),
});

const cart = z.object({
  id: z.uuid().nullable().describe('null when the user has no cart yet'),
  items: z.array(line),
  itemCount: z.number().int().describe('Total units'),
  subtotalMinor: z.number().int().describe('Sum of the lines that are not UNAVAILABLE'),
  currency: z.string(),
  hasIssues: z.boolean().describe('true if any line is not OK (checkout would be refused)'),
});

export class CartVariantParamDto extends createZodDto(z.object({ variantId: z.uuid() })) {}
export class AddCartItemDto extends createZodDto(addItemSchema) {}
export class SetCartItemQuantityDto extends createZodDto(setQuantitySchema) {}
export class CartDto extends createZodDto(cart) {}
