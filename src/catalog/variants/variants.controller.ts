import { Roles } from '../../auth/access.decorators';
import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
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
import { ParseJsonDataPipe } from '../../common/pipes/parse-json-data.pipe';
import { IdParamDto } from '../../common/schemas';
import { CatalogInvalidationInterceptor } from '../catalog-invalidation.interceptor';
import { imageUploadOptions, multipartBody } from '../../media/image-upload';
import { RateLimit } from '../../rate-limit/rate-limit.decorator';
import {
  type CreateVariantInput,
  type UpdateVariantInput,
  VariantDto,
  createVariantSchema,
  updateVariantSchema,
} from './variants.dto';
import { VariantsService } from './variants.service';

const createExample = JSON.stringify({
  sku: 'MBP-16-512-SIL',
  name: '16 GB / 512 GB',
  priceMinor: 149900,
});
const updateExample = JSON.stringify({ priceMinor: 139900 });

@ApiTags('Variants')
@Roles('ADMIN')
@Controller()
@UseInterceptors(CatalogInvalidationInterceptor)
export class VariantsController {
  constructor(private readonly service: VariantsService) {}

  @RateLimit('upload')
  @Post('products/:id/variants')
  @UseInterceptors(FileInterceptor('image', imageUploadOptions))
  @ApiOperation({ summary: 'Add a variant with an optional image (admin, guarded from Phase 13)' })
  @ApiConsumes('multipart/form-data')
  @ApiBody(multipartBody({ field: 'image', dataExample: createExample, dataRequired: true }))
  @ApiCreatedResponse({ type: VariantDto })
  @ApiBadRequestResponse({ description: 'Invalid data JSON or unexpected file field' })
  @ApiNotFoundResponse({ description: 'Product not found' })
  @ApiConflictResponse({ description: 'SKU already exists' })
  @ApiPayloadTooLargeResponse()
  @ApiUnsupportedMediaTypeResponse()
  create(
    @Param() params: IdParamDto,
    @Body('data', new ParseJsonDataPipe(createVariantSchema)) dto: CreateVariantInput,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.service.create(params.id, dto, file);
  }

  @RateLimit('upload')
  @Patch('variants/:id')
  @UseInterceptors(FileInterceptor('image', imageUploadOptions))
  @ApiOperation({
    summary: 'Update a variant; a new image replaces the old one, removeImage deletes it',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody(multipartBody({ field: 'image', dataExample: updateExample, dataRequired: false }))
  @ApiOkResponse({ type: VariantDto })
  @ApiBadRequestResponse({ description: 'Nothing to update or invalid data' })
  @ApiNotFoundResponse()
  @ApiPayloadTooLargeResponse()
  @ApiUnsupportedMediaTypeResponse()
  update(
    @Param() params: IdParamDto,
    @Body('data', new ParseJsonDataPipe(updateVariantSchema, { required: false }))
    dto: UpdateVariantInput,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.service.update(params.id, dto, file);
  }

  @Delete('variants/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Deactivate a variant (soft delete)' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  async deactivate(@Param() params: IdParamDto) {
    await this.service.deactivate(params.id);
  }
}
