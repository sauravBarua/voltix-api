import PDFDocument from 'pdfkit';
import { invoiceMoney, vatIncluded } from './invoice.utils';

export type InvoiceData = {
  number: string;
  issuedAt: Date;
  orderNumber: string;
  paidAt: Date | null;
  currency: string;
  customer: { name: string; email: string };
  address: Record<string, unknown>;
  items: { name: string; sku: string; quantity: number; unitPriceMinor: number }[];
  subtotalMinor: number;
  shippingMinor: number;
  totalMinor: number;
  vatRatePercent: number;
  seller: { name: string; address: string; siren?: string; vatNumber?: string };
};

const date = (d: Date) => d.toISOString().slice(0, 10);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

export function renderInvoicePdf(d: InvoiceData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 50,
      info: { Title: `Invoice ${d.number}`, Author: d.seller.name },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(20).text(d.seller.name, 50, 50);
    doc.fontSize(9).fillColor('#555');
    if (d.seller.address) doc.text(d.seller.address);
    if (d.seller.siren) doc.text(`SIREN: ${d.seller.siren}`);
    if (d.seller.vatNumber) doc.text(`VAT no.: ${d.seller.vatNumber}`);

    doc.fillColor('#000').fontSize(18).text('INVOICE', 350, 50, { width: 195, align: 'right' });
    doc.fontSize(10).text(`No. ${d.number}`, 350, 76, { width: 195, align: 'right' });
    doc.text(`Date: ${date(d.issuedAt)}`, { width: 195, align: 'right' });
    doc.text(`Order: ${d.orderNumber}`, { width: 195, align: 'right' });
    if (d.paidAt) doc.text(`Paid: ${date(d.paidAt)}`, { width: 195, align: 'right' });

    doc.fontSize(10).fillColor('#555').text('Billed to', 50, 150).fillColor('#000');
    doc.text(d.customer.name);
    const a = d.address;
    for (const line of [
      str(a.line1),
      str(a.line2),
      `${str(a.postalCode)} ${str(a.city)}`.trim(),
      str(a.country),
    ])
      if (line) doc.text(line);
    doc.text(d.customer.email);

    let y = 260;
    doc.fontSize(9).fillColor('#555');
    doc
      .text('Description', 50, y)
      .text('Qty', 330, y, { width: 40, align: 'right' })
      .text('Unit price', 375, y, { width: 80, align: 'right' })
      .text('Total', 460, y, { width: 85, align: 'right' });
    doc
      .moveTo(50, y + 14)
      .lineTo(545, y + 14)
      .strokeColor('#999')
      .stroke();
    y += 24;
    doc.fillColor('#000').fontSize(10);
    for (const it of d.items) {
      if (y > 720) {
        doc.addPage();
        y = 50;
      }
      doc
        .text(it.name, 50, y, { width: 270 })
        .text(String(it.quantity), 330, y, { width: 40, align: 'right' })
        .text(invoiceMoney(it.unitPriceMinor, d.currency), 375, y, { width: 80, align: 'right' })
        .text(invoiceMoney(it.unitPriceMinor * it.quantity, d.currency), 460, y, {
          width: 85,
          align: 'right',
        });
      y += Math.max(doc.heightOfString(it.name, { width: 270 }), 14) + 6;
    }

    const row = (label: string, value: string, bold = false) => {
      doc
        .font(bold ? 'Helvetica-Bold' : 'Helvetica')
        .text(label, 330, y, { width: 125, align: 'right' })
        .text(value, 460, y, { width: 85, align: 'right' });
      y += 16;
    };
    y += 8;
    doc.moveTo(330, y).lineTo(545, y).strokeColor('#999').stroke();
    y += 8;
    row('Subtotal (tax incl.)', invoiceMoney(d.subtotalMinor, d.currency));
    row('Shipping', invoiceMoney(d.shippingMinor, d.currency));
    row('Total (tax incl.)', invoiceMoney(d.totalMinor, d.currency), true);
    doc.font('Helvetica').fontSize(9).fillColor('#555');
    row(
      `of which VAT ${d.vatRatePercent}%`,
      invoiceMoney(vatIncluded(d.totalMinor, d.vatRatePercent), d.currency),
    );
    doc.fontSize(8).text('Prices include VAT. Payment received by card.', 50, 780, {
      width: 495,
      align: 'center',
    });
    doc.end();
  });
}
