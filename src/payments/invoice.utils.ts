export const formatInvoiceNumber = (year: number, seq: number) =>
  `INV-${year}-${String(seq).padStart(6, '0')}`;

/** VAT contained in a tax-inclusive total (display only). */
export const vatIncluded = (totalMinor: number, ratePercent: number) =>
  ratePercent <= 0 ? 0 : Math.round((totalMinor * ratePercent) / (100 + ratePercent));

/** Plain "1 234,56 €": the PDF's built-in font has no narrow no-break space. */
export function invoiceMoney(minor: number, currency: string): string {
  const abs = Math.abs(minor);
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const text = `${whole},${String(abs % 100).padStart(2, '0')}`;
  return `${minor < 0 ? '-' : ''}${text} ${currency === 'EUR' ? '€' : currency}`;
}
