import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AvailabilityService } from '../redis/availability.service';
import { CacheService } from '../redis/cache.service';
import { RedisService } from '../redis/redis.service';
import { stableStringify } from '../redis/stable-stringify';
import { BrandsService } from './brands/brands.service';
import { CategoriesService } from './categories/categories.service';
import type { ListProductsDto } from './products/products.dto';
import { ProductsService } from './products/products.service';

const VERSION_KEY = 'cache:catalog:ver'; // no TTL: volatile-lru never evicts it
const TTL = { reference: 600, list: 120, detail: 300 } as const; // seconds

/**
 * Catalog reads: static data cached under a version number (any catalog write bumps it, old keys just
 * expire), with live availability overlaid on every request from the separate stock projection.
 */
@Injectable()
export class CatalogCacheService {
  constructor(
    private readonly cache: CacheService,
    private readonly redis: RedisService,
    private readonly availability: AvailabilityService,
    private readonly categoriesService: CategoriesService,
    private readonly brandsService: BrandsService,
    private readonly productsService: ProductsService,
  ) {}

  categories() {
    return this.cached('categories', TTL.reference, () => this.categoriesService.list());
  }

  brands() {
    return this.cached('brands', TTL.reference, () => this.brandsService.list());
  }

  async listProducts(query: ListProductsDto) {
    // Free-text searches are too varied to cache (and would let anyone fill the cache)
    const page = query.q
      ? await this.productsService.list(query)
      : await this.cached(`products:${this.hash(query)}`, TTL.list, () =>
          this.productsService.list(query),
        );

    const stock = await this.availability.getMany(page.items.flatMap((i) => i.variantIds));
    return {
      items: page.items.map(({ variantIds, ...rest }) => ({
        ...rest,
        inStock: variantIds.some((id) => (stock.get(id) ?? 0) > 0),
      })),
      meta: page.meta,
    };
  }

  async getProduct(slug: string) {
    const product = await this.cached(`product:${slug}`, TTL.detail, () =>
      this.productsService.getBySlug(slug),
    );
    const { variantIds, variants, ...rest } = product;
    const stock = await this.availability.getMany(variantIds);
    return {
      ...rest,
      inStock: variantIds.some((id) => (stock.get(id) ?? 0) > 0),
      variants: variants.map((v) => ({ ...v, available: stock.get(v.id) ?? 0 })),
    };
  }

  /** Called after a catalog write succeeded. A failure only means entries live until their TTL. */
  async bump(): Promise<void> {
    try {
      await this.redis.client.incr(VERSION_KEY);
    } catch (error) {
      this.redis.logThrottled(error);
    }
  }

  private async cached<T>(part: string, ttl: number, loader: () => Promise<T>): Promise<T> {
    return this.cache.getOrSet(`cache:catalog:v${await this.version()}:${part}`, ttl, loader);
  }

  private async version(): Promise<string> {
    try {
      return (await this.redis.client.get(VERSION_KEY)) ?? '0';
    } catch (error) {
      this.redis.logThrottled(error);
      return '0';
    }
  }

  private hash(query: ListProductsDto): string {
    return createHash('sha1').update(stableStringify(query)).digest('hex').slice(0, 20);
  }
}
