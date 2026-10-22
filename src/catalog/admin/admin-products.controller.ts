import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiNotFoundResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../auth/access.decorators'; // adjust the path
import {
  AdminProductDetailDto,
  AdminProductListDto,
  AdminProductsQueryDto,
} from './admin-products.dto';
import { AdminProductsService } from './admin-products.service';

@ApiTags('admin-products')
@Roles('ADMIN', 'INVENTORY_OPERATOR')
@Controller('admin/products')
export class AdminProductsController {
  constructor(private readonly service: AdminProductsService) {}

  @Get()
  @ApiOkResponse({ type: AdminProductListDto })
  list(@Query() query: AdminProductsQueryDto) {
    return this.service.list(query);
  }

  @Get(':id')
  @ApiOkResponse({ type: AdminProductDetailDto })
  @ApiNotFoundResponse()
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(id);
  }
}
