import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/access.decorators';
import { JobsStatusDto } from './jobs-admin.dto';
import { JobsAdminService } from './jobs-admin.service';

@ApiTags('Admin jobs')
@Roles('ADMIN')
@Controller('admin/jobs')
export class JobsAdminController {
  constructor(private readonly service: JobsAdminService) {}

  @Get()
  @ApiOperation({
    summary: 'Background jobs: last run, result, health and whether one is running now (read-only)',
  })
  @ApiOkResponse({ type: JobsStatusDto })
  status() {
    return this.service.status();
  }
}
