import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module';
import { BrandsController } from './brands/brands.controller';
import { BrandsService } from './brands/brands.service';
import { CatalogCacheService } from './catalog-cache.service';
import { CatalogInvalidationInterceptor } from './catalog-invalidation.interceptor';
import { CategoriesController } from './categories/categories.controller';
import { CategoriesService } from './categories/categories.service';
import { ProductsController } from './products/products.controller';
import { ProductsService } from './products/products.service';
import { VariantsController } from './variants/variants.controller';
import { VariantsService } from './variants/variants.service';

@Module({
  imports: [MediaModule],
  controllers: [CategoriesController, BrandsController, ProductsController, VariantsController],
  providers: [
    CategoriesService,
    BrandsService,
    ProductsService,
    VariantsService,
    CatalogCacheService,
    CatalogInvalidationInterceptor,
  ],
})
export class CatalogModule {}
