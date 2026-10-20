import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StripeService } from './stripe.service';

export type InvoiceInfo = { number: string | null; hostedInvoiceUrl: string; pdfUrl: string };

/** Stripe owns the invoice (numbering, layout, PDF). We only look it up through the Checkout Session. */
@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
  ) {}

  /** null = no invoice (yet): the session predates invoice_creation, or Stripe has not finalized it. */
  async findForOrder(orderId: string): Promise<InvoiceInfo | null> {
    const payment = await this.prisma.payment.findFirst({
      where: { orderId, status: { in: ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'] } },
      select: { stripeSessionId: true },
    });
    if (!payment) return null;

    const session = await this.stripe.client.checkout.sessions.retrieve(payment.stripeSessionId);
    const invoiceId =
      typeof session.invoice === 'string' ? session.invoice : (session.invoice?.id ?? null);
    if (!invoiceId) return null;

    const invoice = await this.stripe.client.invoices.retrieve(invoiceId);
    if (!invoice.hosted_invoice_url || !invoice.invoice_pdf) return null;
    return {
      number: invoice.number ?? null,
      hostedInvoiceUrl: invoice.hosted_invoice_url,
      pdfUrl: invoice.invoice_pdf,
    };
  }

  /** For the owner of the order only (404 for anyone else, like the other order endpoints). */
  async forOwner(userId: string, orderId: string): Promise<InvoiceInfo> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, userId },
      select: { id: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    const invoice = await this.findForOrder(orderId);
    if (!invoice) throw new NotFoundException('Invoice not available yet');
    return invoice;
  }
}
