export type OrderPaidEmailInput = {
  name: string;
  orderNumber: string;
  totalMinor: number;
  currency: string;
  invoice?: { number: string | null; hostedUrl: string; pdfUrl: string };
};

const escapeHtml = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

export const formatMoney = (minor: number, currency: string) =>
  (minor / 100).toLocaleString('fr-FR', { style: 'currency', currency });

export function orderPaidEmail(o: OrderPaidEmailInput) {
  const total = formatMoney(o.totalMinor, o.currency);
  const subject = `Voltix: payment received for order ${o.orderNumber}`;
  const invoiceText = o.invoice
    ? `\nInvoice${o.invoice.number ? ` ${o.invoice.number}` : ''}: ${o.invoice.hostedUrl}\nPDF: ${o.invoice.pdfUrl}\n`
    : '\nYour invoice will be available in your order history shortly.\n';
  const text = `Hello ${o.name},\n\nThank you for your order ${o.orderNumber}. We received your payment of ${total}.\n${invoiceText}\nWe will let you know when it ships.\n\nVoltix`;
  const invoiceHtml = o.invoice
    ? `<p><a href="${escapeHtml(o.invoice.hostedUrl)}">View your invoice${o.invoice.number ? ` ${escapeHtml(o.invoice.number)}` : ''}</a> · <a href="${escapeHtml(o.invoice.pdfUrl)}">Download the PDF</a></p>`
    : '<p>Your invoice will be available in your order history shortly.</p>';
  const html = `<p>Hello ${escapeHtml(o.name)},</p><p>Thank you for your order <strong>${escapeHtml(o.orderNumber)}</strong>. We received your payment of <strong>${escapeHtml(total)}</strong>.</p>${invoiceHtml}<p>We will let you know when it ships.</p><p>Voltix</p>`;
  return { subject, text, html };
}
