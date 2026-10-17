import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiTags,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import { IdParamDto, SlugParamDto } from '../../common/schemas';
import { CatalogCacheService } from '../catalog-cache.service';
import { CatalogInvalidationInterceptor } from '../catalog-invalidation.interceptor';
import { ParseJsonDataPipe } from '../../common/pipes/parse-json-data.pipe';
import { imageUploadOptions, multipartBody } from '../../media/image-upload';
import { MAX_FILES_PER_REQUEST } from '../../media/media.constants';
import { RateLimit } from '../../rate-limit/rate-limit.decorator';
import {
  type CreateProductInput,
  ListProductsDto,
  ProductDetailDto,
  ProductImageParamDto,
  ProductListDto,
  type UpdateProductInput,
  createProductSchema,
  updateProductSchema,
} from './products.dto';
import { ProductsService } from './products.service';

const createExample = JSON.stringify({
  name: 'Dell XPS 15',
  brandId: '<brand uuid>',
  categoryId: '<category uuid>',
  specs: { cpu: 'Intel Core i7', screenSizeInch: 15.6, os: 'Windows 11' },
});
const updateExample = JSON.stringify({ description: 'New text', removeImageIds: ['<image uuid>'] });

@ApiTags('Products')
@Controller('products')
@UseInterceptors(CatalogInvalidationInterceptor)
export class ProductsController {
  constructor(
    private readonly service: ProductsService,
    private readonly cache: CatalogCacheService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Search and filter products (public)' })
  @ApiOkResponse({ type: ProductListDto })
  @ApiBadRequestResponse({ description: 'Invalid query parameters' })
  list(@Query() query: ListProductsDto) {
    return this.cache.listProducts(query);
  }

  @Get(':slug')
  @ApiOperation({ summary: 'Product detail with active variants (public)' })
  @ApiOkResponse({ type: ProductDetailDto })
  @ApiNotFoundResponse()
  get(@Param() params: SlugParamDto) {
    return this.cache.getProduct(params.slug);
  }

  @RateLimit('upload')
  @Post()
  @UseInterceptors(FilesInterceptor('images', MAX_FILES_PER_REQUEST, imageUploadOptions))
  @ApiOperation({ summary: 'Create a product with optional images (admin, guarded from Phase 13)' })
  @ApiConsumes('multipart/form-data')
  @ApiBody(multipartBody({ field: 'images', dataExample: createExample, dataRequired: true }))
  @ApiCreatedResponse({ type: ProductDetailDto })
  @ApiBadRequestResponse({
    description: 'Invalid data JSON, invalid specs for the category, or unexpected file field',
  })
  @ApiConflictResponse({ description: 'Slug already exists' })
  @ApiPayloadTooLargeResponse({ description: 'Image larger than 5 MB' })
  @ApiUnsupportedMediaTypeResponse({
    description: 'Only jpeg, png, webp and avif images are accepted',
  })
  create(
    @Body('data', new ParseJsonDataPipe(createProductSchema)) dto: CreateProductInput,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    return this.service.create(dto, files);
  }

  @RateLimit('upload')
  @Patch(':id')
  @UseInterceptors(FilesInterceptor('images', MAX_FILES_PER_REQUEST, imageUploadOptions))
  @ApiOperation({
    summary:
      'Update a product; add images, remove them via removeImageIds (specs are replaced, not merged)',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody(multipartBody({ field: 'images', dataExample: updateExample, dataRequired: false }))
  @ApiOkResponse({ type: ProductDetailDto })
  @ApiBadRequestResponse({
    description: 'Nothing to update, invalid data, or image id not on this product',
  })
  @ApiNotFoundResponse()
  @ApiPayloadTooLargeResponse()
  @ApiUnsupportedMediaTypeResponse()
  update(
    @Param() params: IdParamDto,
    @Body('data', new ParseJsonDataPipe(updateProductSchema, { required: false }))
    dto: UpdateProductInput,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    return this.service.update(params.id, dto, files);
  }

  @Delete(':id/images/:imageId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete one product image (also deletes the Cloudinary asset)' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  async removeImage(@Param() params: ProductImageParamDto) {
    await this.service.removeImage(params.id, params.imageId);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Deactivate a product (soft delete, images are kept)' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  async remove(@Param() params: IdParamDto) {
    await this.service.deactivate(params.id);
  }
}
