import { orderPaidEmail } from './order-paid.email';

const base = {
  name: 'Alice',
  orderNumber: 'VLX-20261020-ABCD1234',
  totalMinor: 299800,
  currency: 'EUR',
};

describe('orderPaidEmail', () => {
  it('includes the order number, the amount and the invoice links', () => {
    const mail = orderPaidEmail({
      ...base,
      invoice: {
        number: 'INV-0001',
        hostedUrl: 'https://i.stripe.test/x',
        pdfUrl: 'https://i.stripe.test/x.pdf',
      },
    });
    expect(mail.subject).toContain('VLX-20261020-ABCD1234');
    expect(mail.text).toContain('https://i.stripe.test/x.pdf');
    expect(mail.html).toContain('INV-0001');
    expect(mail.text.replace(/\s/g, ' ')).toMatch(/2\s?998,00\s?€/);
  });

  it('degrades gracefully without an invoice', () => {
    expect(orderPaidEmail(base).text).toContain('invoice will be available');
  });

  it('escapes customer-controlled text in the HTML', () => {
    expect(orderPaidEmail({ ...base, name: '<script>alert(1)</script>' }).html).not.toContain(
      '<script>',
    );
  });
});
