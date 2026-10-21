import { contactEmail, escapeHtml, oneLine } from './contact.utils';

describe('contact utils', () => {
  it('oneLine removes header-injection characters', () => {
    expect(oneLine('Hello\r\nBcc: evil@x.com')).toBe('Hello Bcc: evil@x.com');
    expect(oneLine('a\nb\rc')).not.toMatch(/[\r\n]/);
  });
  it('escapeHtml', () => {
    expect(escapeHtml(`<script>alert("x")</script>&'`)).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;',
    );
  });
  it('contactEmail builds a safe subject and escaped html', () => {
    const m = contactEmail({
      name: 'Eve\r\nBcc: a@b.c',
      email: 'eve@example.com',
      subject: 'Ma commande\r\nX: y',
      message: '<b>hi</b>\nline2',
    });
    expect(m.subject).toBe('[Voltix contact] Ma commande X: y');
    expect(m.html).toContain('&lt;b&gt;hi&lt;/b&gt;');
    expect(m.html).not.toContain('<b>');
    expect(m.text).toContain('line2');
    expect(
      contactEmail({ name: 'a', email: 'a@b.c', subject: 'x'.repeat(500), message: 'm' }).subject
        .length,
    ).toBeLessThanOrEqual(200);
  });
});
