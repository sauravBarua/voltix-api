import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { IdParamDto } from '../common/schemas';
import { ListOutboxDto, OutboxEventDto, OutboxListDto, OutboxSummaryDto } from './outbox.dto';
import { OutboxAdminService } from './outbox-admin.service';

// No guard until Phase 13 (administrator only afterwards)
@ApiTags('Admin outbox')
@Controller('admin/outbox')
export class OutboxAdminController {
  constructor(private readonly service: OutboxAdminService) {}

  @Get('summary')
  @ApiOperation({
    summary: 'Counts per status and the age of the oldest unpublished event (publishing lag)',
  })
  @ApiOkResponse({ type: OutboxSummaryDto })
  summary() {
    return this.service.summary();
  }

  @Get()
  @ApiOperation({ summary: 'Outbox events, newest first (filter by status or type)' })
  @ApiOkResponse({ type: OutboxListDto })
  list(@Query() query: ListOutboxDto) {
    return this.service.list(query);
  }

  @Post(':id/retry')
  @HttpCode(200)
  @ApiOperation({ summary: 'Give a FAILED event a fresh set of publish attempts' })
  @ApiOkResponse({ type: OutboxEventDto })
  @ApiNotFoundResponse()
  @ApiConflictResponse({ description: 'The event is not FAILED' })
  retry(@Param() params: IdParamDto) {
    return this.service.retry(params.id);
  }
}
