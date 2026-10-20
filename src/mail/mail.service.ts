import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Transporter, createTransport } from 'nodemailer';
import type { Env } from '../config/env';

export type Mail = { to: string; subject: string; text: string; html: string };

/** Plain SMTP. Disabled (log only) without settings, and always off under NODE_ENV=test. */
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
          socketTimeout: 15_000,
        })
      : null;
    this.logger.log(
      this.enabled
        ? `Mail enabled via ${host}:${port}`
        : 'Mail disabled: notifications are only logged',
    );
  }

  /** Throws on failure so the consumer retries. Never logs the body or the password. */
  async send(mail: Mail): Promise<void> {
    if (!this.transporter) return;
    await this.transporter.sendMail({ from: this.from, ...mail });
    this.logger.log(`Email sent: "${mail.subject}"`);
  }
}
