import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Transporter, createTransport } from 'nodemailer';
import type { Env } from '../config/env';
import { PoisonMessageError } from '../messaging/envelope';

export type Mail = {
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments?: { filename: string; content: Buffer; contentType: string }[];
};

// Problems that retrying cannot fix: park the message at once
const PERMANENT = new Set(['EAUTH', 'EENVELOPE']);

/** Plain SMTP. Log-only without settings, and always off under NODE_ENV=test. */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: Transporter | null;
  private readonly from: string;
  readonly enabled: boolean;

  constructor(config: ConfigService<Env, true>) {
    const host = config.get('SMTP_HOST', { infer: true });
    const user = config.get('SMTP_USER', { infer: true });
    const pass = config.get('SMTP_PASS', { infer: true });
    const port = config.get('SMTP_PORT', { infer: true }) ?? 465;
    this.from =
      config.get('MAIL_FROM', { infer: true }) ?? `Voltix <${user ?? 'noreply@voltix.local'}>`;
    this.enabled =
      Boolean(host && user && pass) &&
      (config.get('MAIL_ENABLED', { infer: true }) ??
        config.get('NODE_ENV', { infer: true }) !== 'test');
    this.transporter = this.enabled
      ? createTransport({
          host,
          port,
          secure: port === 465,
          auth: { user, pass },
          connectionTimeout: 10_000,
          greetingTimeout: 10_000,
          socketTimeout: 20_000,
        })
      : null;
    this.logger.log(
      this.enabled
        ? `Mail enabled via ${host}:${port}`
        : 'Mail disabled: notifications are only logged',
    );
  }

  async send(mail: Mail): Promise<void> {
    if (!this.transporter) return;
    try {
      await this.transporter.sendMail({ from: this.from, ...mail });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      const message = `SMTP ${String(code ?? 'error')}: ${error instanceof Error ? error.message : String(error)}`;
      throw typeof code === 'string' && PERMANENT.has(code)
        ? new PoisonMessageError(message)
        : new Error(message);
    }
    this.logger.log(`Email sent: "${mail.subject}"`); // never log the body, attachment or password
  }
}
