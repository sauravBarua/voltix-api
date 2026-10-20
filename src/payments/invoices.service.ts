import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { renderInvoicePdf } from './invoice.pdf';
import { formatInvoiceNumber } from './invoice.utils';

type Db = Prisma.TransactionClient;

@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Idempotent: the same order always gets the same number. Gapless, because the counter rolls back with us. */
  async ensure(tx: Db, orderId: string): Promise<{ number: string; issuedAt: Date }> {
    await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext(${`invoice:${orderId}`}::text))) AS t`;
    const existing = await tx.invoice.findUnique({
      where: { orderId },
      select: { number: true, issuedAt: true },
    });
    if (existing) return existing;

    const year = new Date().getUTCFullYear();
    const [row] = await tx.$queryRaw<{ last_seq: number }[]>`
      INSERT INTO invoice_counters (year, last_seq) VALUES (${year}::int, 1)
      ON CONFLICT (year) DO UPDATE SET last_seq = invoice_counters.last_seq + 1
      RETURNING last_seq`;
    return tx.invoice.create({
      data: { orderId, number: formatInvoiceNumber(year, row.last_seq) },
      select: { number: true, issuedAt: true },
    });
  }

  /** Invoice number and PDF of a PAID order. Returns null while the order has not been paid. */
  async pdf(tx: Db, orderId: string): Promise<{ number: string; buffer: Buffer } | null> {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        orderNumber: true,
        paidAt: true,
        currency: true,
        shippingAddress: true,
        subtotalMinor: true,
        shippingMinor: true,
        totalMinor: true,
        user: { select: { name: true, email: true } },
        items: {
          orderBy: { skuSnapshot: 'asc' },
          select: {
            nameSnapshot: true,
            skuSnapshot: true,
            quantity: true,
            unitPriceMinor: true,
          },
        },
      },
    });
    if (!order?.paidAt) return null;
    const invoice = await this.ensure(tx, orderId);

    const buffer = await renderInvoicePdf({
      number: invoice.number,
      issuedAt: invoice.issuedAt,
      orderNumber: order.orderNumber,
      paidAt: order.paidAt,
      currency: order.currency,
      customer: order.user,
      address: order.shippingAddress as Record<string, unknown>,
      items: order.items.map((i) => ({
        name: i.nameSnapshot,
        sku: i.skuSnapshot,
        quantity: i.quantity,
        unitPriceMinor: i.unitPriceMinor,
      })),
      subtotalMinor: order.subtotalMinor,
      shippingMinor: order.shippingMinor,
      totalMinor: order.totalMinor,
      vatRatePercent: this.config.get('VAT_RATE_PERCENT', { infer: true }),
      seller: {
        name: this.config.get('SELLER_NAME', { infer: true }),
        address: this.config.get('SELLER_ADDRESS', { infer: true }),
        siren: this.config.get('SELLER_SIREN', { infer: true }),
        vatNumber: this.config.get('SELLER_VAT_NUMBER', { infer: true }),
      },
    });
    return { number: invoice.number, buffer };
  }

  /** Owner download. 404 for other users' orders and for unpaid orders. */
  async forOwner(userId: string, orderId: string) {
    const owned = await this.prisma.order.count({ where: { id: orderId, userId } });
    return this.download(orderId, owned > 0);
  }

  async forAdmin(orderId: string) {
    return this.download(orderId, true);
  }

  private async download(orderId: string, allowed: boolean) {
    const result = allowed
      ? await this.prisma.$transaction((tx) => this.pdf(tx, orderId), { timeout: 20_000 })
      : null;
    if (!result) throw new NotFoundException('Invoice not available');
    return result;
  }
}
