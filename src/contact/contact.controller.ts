import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../auth/access.decorators';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { ContactDto } from './contact.dto';
import { ContactService } from './contact.service';

@ApiTags('Contact')
@Controller('contact')
export class ContactController {
  constructor(private readonly service: ContactService) {}

  @Post()
  @Public()
  @RateLimit('strict')
  @HttpCode(202)
  @ApiOperation({ summary: 'Send a message to the support team (public, rate limited)' })
  @ApiAcceptedResponse({ description: 'The message was handed to the mail server' })
  @ApiBadRequestResponse({ description: 'Invalid name, e-mail, subject or message' })
  @ApiServiceUnavailableResponse({ description: 'Mail is not configured' })
  async send(@Body() dto: ContactDto) {
    await this.service.send(dto);
  }
}
