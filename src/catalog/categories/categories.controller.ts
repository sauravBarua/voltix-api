import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
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
import { CategoriesService } from './categories.service';
import { CategoryDto, CreateCategoryDto, UpdateCategoryDto } from './categories.dto';

@ApiTags('Categories')
@Controller('categories')
export class CategoriesController {
  constructor(private readonly service: CategoriesService) {}

  @Get()
  @ApiOperation({ summary: 'List categories (public)' })
  @ApiOkResponse({ type: [CategoryDto] })
  list() {
    return this.service.list();
  }

  @Post()
  @ApiOperation({ summary: 'Create a category (admin, guarded from Phase 13)' })
  @ApiCreatedResponse({ type: CategoryDto })
  @ApiConflictResponse({ description: 'Name or slug already exists' })
  create(@Body() dto: CreateCategoryDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a category' })
  @ApiOkResponse({ type: CategoryDto })
  @ApiNotFoundResponse()
  update(@Param() params: IdParamDto, @Body() dto: UpdateCategoryDto) {
    return this.service.update(params.id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a category (409 if in use)' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  @ApiConflictResponse({ description: 'Category has products or children' })
  async remove(@Param() params: IdParamDto) {
    await this.service.remove(params.id);
  }
}
