import { formatInvoiceNumber, invoiceMoney, vatIncluded } from './invoice.utils';

describe('invoice utils', () => {
  it('formats numbers with a zero-padded sequence', () => {
    expect(formatInvoiceNumber(2026, 1)).toBe('INV-2026-000001');
    expect(formatInvoiceNumber(2026, 1234)).toBe('INV-2026-001234');
  });

  it('extracts VAT from a tax-inclusive total', () => {
    expect(vatIncluded(12000, 20)).toBe(2000);
    expect(vatIncluded(299800, 20)).toBe(49967);
    expect(vatIncluded(1000, 0)).toBe(0);
  });

  it('formats money', () => {
    expect(invoiceMoney(299800, 'EUR')).toBe('2 998,00 €');
    expect(invoiceMoney(5, 'EUR')).toBe('0,05 €');
    expect(invoiceMoney(1000, 'USD')).toBe('10,00 USD');
  });
});
