export type OrderPaidEmailInput = {
  name: string;
  orderNumber: string;
  totalMinor: number;
  currency: string;
  invoice?: { number: string };
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
  const invoiceText = o.invoice ? `\nYour invoice ${o.invoice.number} is attached (PDF).\n` : '';
  const text = `Hello ${o.name},\n\nThank you for your order ${o.orderNumber}. We received your payment of ${total}.\n${invoiceText}\nWe will let you know when it ships.\n\nVoltix`;
  const invoiceHtml = o.invoice
    ? `<p>Your invoice <strong>${escapeHtml(o.invoice.number)}</strong> is attached (PDF).</p>`
    : '';
  const html = `<p>Hello ${escapeHtml(o.name)},</p><p>Thank you for your order <strong>${escapeHtml(o.orderNumber)}</strong>. We received your payment of <strong>${escapeHtml(total)}</strong>.</p>${invoiceHtml}<p>We will let you know when it ships.</p><p>Voltix</p>`;
  return { subject, text, html };
}
