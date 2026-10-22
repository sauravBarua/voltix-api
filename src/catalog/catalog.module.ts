import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module';
import { AdminProductsController } from './admin/admin-products.controller';
import { AdminProductsService } from './admin/admin-products.service';
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
  controllers: [
    CategoriesController,
    BrandsController,
    ProductsController,
    VariantsController,
    AdminProductsController,
  ],
  providers: [
    CategoriesService,
    BrandsService,
    ProductsService,
    VariantsService,
    AdminProductsService,
    CatalogCacheService,
    CatalogInvalidationInterceptor,
  ],
})
export class CatalogModule {}
