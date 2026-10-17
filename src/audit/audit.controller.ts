import { Controller, Get, Query } from '@nestjs/common';
import { ApiBadRequestResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/access.decorators';
import { AuditListDto, ListAuditDto } from './audit.dto';
import { AuditService } from './audit.service';

@ApiTags('Admin audit')
@Roles('ADMIN')
@Controller('admin/audit-logs')
export class AuditController {
  constructor(private readonly service: AuditService) {}

  @Get()
  @ApiOperation({ summary: 'Audit trail, newest first (append-only)' })
  @ApiOkResponse({ type: AuditListDto })
  @ApiBadRequestResponse({ description: 'Invalid filter' })
  list(@Query() query: ListAuditDto) {
    return this.service.list(query);
  }
}
