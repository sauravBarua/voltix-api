import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env';
import { MailService } from '../mail/mail.service';
import type { ContactDto } from './contact.dto';
import { contactEmail } from './contact.utils';

@Injectable()
export class ContactService {
  private readonly to: string | undefined;

  constructor(
    private readonly mail: MailService,
    config: ConfigService<Env, true>,
  ) {
    this.to = config.get('CONTACT_TO', { infer: true }) ?? config.get('SMTP_USER', { infer: true });
  }

  async send(dto: ContactDto): Promise<void> {
    if (!this.mail.enabled || !this.to)
      throw new ServiceUnavailableException('Contact is temporarily unavailable');
    // The visitor's address is in the body; replies are sent manually from the support inbox.
    await this.mail.send({ to: this.to, ...contactEmail(dto) });
  }
}
