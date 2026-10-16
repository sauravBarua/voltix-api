import { Body, Controller, Delete, HttpCode, Param, Patch, Post } from '@nestjs/common';
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
import { CreateVariantDto, UpdateVariantDto, VariantDto } from './variants.dto';
import { VariantsService } from './variants.service';

@ApiTags('Variants')
@Controller()
export class VariantsController {
  constructor(private readonly service: VariantsService) {}

  @Post('products/:id/variants')
  @ApiOperation({ summary: 'Add a variant to a product (admin, guarded from Phase 13)' })
  @ApiCreatedResponse({ type: VariantDto })
  @ApiNotFoundResponse({ description: 'Product not found' })
  @ApiConflictResponse({ description: 'SKU already exists' })
  create(@Param() params: IdParamDto, @Body() dto: CreateVariantDto) {
    return this.service.create(params.id, dto);
  }

  @Patch('variants/:id')
  @ApiOperation({ summary: 'Update a variant (price, name, attributes, active flag)' })
  @ApiOkResponse({ type: VariantDto })
  @ApiNotFoundResponse()
  update(@Param() params: IdParamDto, @Body() dto: UpdateVariantDto) {
    return this.service.update(params.id, dto);
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
