import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { IdParamDto } from '../../common/schemas';
import { CatalogCacheService } from '../catalog-cache.service';
import { CatalogInvalidationInterceptor } from '../catalog-invalidation.interceptor';
import { BrandDto, CreateBrandDto, UpdateBrandDto } from './brands.dto';
import { BrandsService } from './brands.service';

@ApiTags('Brands')
@Controller('brands')
@UseInterceptors(CatalogInvalidationInterceptor)
export class BrandsController {
  constructor(
    private readonly service: BrandsService,
    private readonly cache: CatalogCacheService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List brands (public)' })
  @ApiOkResponse({ type: [BrandDto] })
  list() {
    return this.cache.brands();
  }

  @Post()
  @ApiOperation({ summary: 'Create a brand (admin, guarded from Phase 13)' })
  @ApiCreatedResponse({ type: BrandDto })
  @ApiConflictResponse({ description: 'Name or slug already exists' })
  create(@Body() dto: CreateBrandDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a brand' })
  @ApiOkResponse({ type: BrandDto })
  @ApiNotFoundResponse()
  update(@Param() params: IdParamDto, @Body() dto: UpdateBrandDto) {
    return this.service.update(params.id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a brand (409 if it has products)' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  @ApiConflictResponse({ description: 'Brand has products' })
  async remove(@Param() params: IdParamDto) {
    await this.service.remove(params.id);
  }
}
