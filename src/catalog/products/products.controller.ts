import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { IdParamDto, SlugParamDto } from '../../common/schemas';
import {
  CreateProductDto,
  ListProductsDto,
  ProductDetailDto,
  ProductListDto,
  UpdateProductDto,
} from './products.dto';
import { ProductsService } from './products.service';

@ApiTags('Products')
@Controller('products')
export class ProductsController {
  constructor(private readonly service: ProductsService) {}

  @Get()
  @ApiOperation({ summary: 'Search and filter products (public)' })
  @ApiOkResponse({ type: ProductListDto })
  @ApiBadRequestResponse({ description: 'Invalid query parameters' })
  list(@Query() query: ListProductsDto) {
    return this.service.list(query);
  }

  @Get(':slug')
  @ApiOperation({ summary: 'Product detail with active variants (public)' })
  @ApiOkResponse({ type: ProductDetailDto })
  @ApiNotFoundResponse()
  get(@Param() params: SlugParamDto) {
    return this.service.getBySlug(params.slug);
  }

  @Post()
  @ApiOperation({ summary: 'Create a product (admin, guarded from Phase 13)' })
  @ApiCreatedResponse({ type: ProductDetailDto })
  @ApiBadRequestResponse({ description: 'Validation error or invalid specs for the category' })
  @ApiConflictResponse({ description: 'Slug already exists' })
  create(@Body() dto: CreateProductDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a product (specs are replaced, not merged)' })
  @ApiOkResponse({ type: ProductDetailDto })
  @ApiNotFoundResponse()
  update(@Param() params: IdParamDto, @Body() dto: UpdateProductDto) {
    return this.service.update(params.id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Deactivate a product (soft delete)' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  async remove(@Param() params: IdParamDto) {
    await this.service.deactivate(params.id);
  }
}
