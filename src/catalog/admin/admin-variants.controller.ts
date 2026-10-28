import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../auth/access.decorators';
import { AdminVariantListDto, AdminVariantsQueryDto } from './admin-variants.dto';
import { AdminVariantsService } from './admin-variants.service';

@ApiTags('admin-variants')
@Roles('ADMIN', 'INVENTORY_OPERATOR')
@Controller('admin/variants')
export class AdminVariantsController {
  constructor(private readonly service: AdminVariantsService) {}

  @Get()
  @ApiOperation({ summary: 'All variants with product, price and stock (including inactive)' })
  @ApiOkResponse({ type: AdminVariantListDto })
  list(@Query() query: AdminVariantsQueryDto) {
    return this.service.list(query);
  }
}
