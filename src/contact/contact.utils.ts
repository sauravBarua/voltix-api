/** Collapses any whitespace, including CR/LF, so user input can never inject mail headers. */
export function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export type ContactInput = { name: string; email: string; subject: string; message: string };

export function contactEmail(input: ContactInput) {
  const name = oneLine(input.name);
  const email = oneLine(input.email);
  const subject = `[Voltix contact] ${oneLine(input.subject)}`.slice(0, 200);
  const text = `From: ${name} <${email}>\n\n${input.message}`;
  const html =
    `<p><strong>${escapeHtml(name)}</strong> &lt;${escapeHtml(email)}&gt;</p>` +
    `<p style="white-space:pre-wrap">${escapeHtml(input.message)}</p>`;
  return { subject, text, html };
}
