import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { resolveSlug } from '../../common/utils/slugify';
import { getSpecsSchema } from '../specs/specs.schemas';
import {
  type ProductRow,
  mapProductDetail,
  mapProductSummary,
  productInclude,
} from './product.mapper';
import type { CreateProductDto, ListProductsDto, UpdateProductDto } from './products.dto';

const ORDER_BY: Record<
  'newest' | 'name_asc' | 'name_desc',
  Prisma.ProductOrderByWithRelationInput[]
> = {
  newest: [{ createdAt: 'desc' }, { id: 'desc' }],
  name_asc: [{ name: 'asc' }, { id: 'asc' }],
  name_desc: [{ name: 'desc' }, { id: 'desc' }],
};

const jsonFilterSchema = z.record(
  z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,40}$/),
  z.union([z.string(), z.number(), z.boolean()]),
);

function splitCsv(value?: string): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** '{"os":"macOS"}' -> Prisma JSON path filters (equality only). */
function parseJsonFilter(raw: string | undefined, name: string) {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BadRequestException(`${name} must be a valid JSON object`);
  }
  const result = jsonFilterSchema.safeParse(parsed);
  if (!result.success) {
    throw new BadRequestException(
      `${name} must be a flat JSON object of string, number or boolean values`,
    );
  }
  return Object.entries(result.data).map(([key, value]) => ({ path: [key], equals: value }));
}

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListProductsDto) {
    const { page, pageSize, sort } = query;
    const { where, variantWhere } = this.buildWhere(query);
    const include = productInclude(variantWhere);
    const meta = (total: number) => ({
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    });

    if (sort === 'price_asc' || sort === 'price_desc') {
      // Prisma cannot order by MIN(variant price), so rank ids first (lightweight), then hydrate one page.
      // Fine for a few thousand products; denormalize min price later if the catalog grows.
      const rows = await this.prisma.product.findMany({
        where,
        select: { id: true, variants: { where: variantWhere, select: { priceMinor: true } } },
      });
      const dir = sort === 'price_asc' ? 1 : -1;
      const ids = rows
        .map((r) => ({ id: r.id, min: Math.min(...r.variants.map((v) => v.priceMinor)) }))
        .sort((a, b) => dir * (a.min - b.min) || a.id.localeCompare(b.id))
        .slice((page - 1) * pageSize, page * pageSize)
        .map((r) => r.id);
      const products = await this.prisma.product.findMany({ where: { id: { in: ids } }, include });
      const byId = new Map(products.map((p) => [p.id, p]));
      const items = ids.map((id) => byId.get(id)).filter((p): p is ProductRow => p !== undefined);
      return { items: items.map(mapProductSummary), meta: meta(rows.length) };
    }

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.product.count({ where }),
      this.prisma.product.findMany({
        where,
        include,
        orderBy: ORDER_BY[sort],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { items: rows.map(mapProductSummary), meta: meta(total) };
  }

  async getBySlug(slug: string) {
    const product = await this.prisma.product.findFirst({
      where: { slug, isActive: true },
      include: productInclude({ isActive: true }),
    });
    if (!product) throw new NotFoundException('Product not found');
    return mapProductDetail(product);
  }

  async create(dto: CreateProductDto) {
    const category = await this.getCategory(dto.categoryId);
    await this.assertBrandExists(dto.brandId);
    const specs = this.validateSpecs(category, dto.specs);

    const product = await this.prisma.product.create({
      data: {
        name: dto.name,
        slug: resolveSlug(dto.name, dto.slug),
        description: dto.description,
        brandId: dto.brandId,
        categoryId: dto.categoryId,
        specs,
        warrantyMonths: dto.warrantyMonths,
        isActive: dto.isActive,
      },
      include: productInclude({}),
    });
    return mapProductDetail(product);
  }

  async update(id: string, dto: UpdateProductDto) {
    const existing = await this.prisma.product.findUnique({
      where: { id },
      select: { categoryId: true, specs: true },
    });
    if (!existing) throw new NotFoundException('Product not found');
    if (dto.brandId) await this.assertBrandExists(dto.brandId);

    // Re-validate specs whenever the specs or the category change (specs are replaced, not merged)
    let specs: Prisma.InputJsonObject | undefined;
    if (dto.specs !== undefined || dto.categoryId !== undefined) {
      const category = await this.getCategory(dto.categoryId ?? existing.categoryId);
      specs = this.validateSpecs(category, dto.specs ?? existing.specs);
    }

    const product = await this.prisma.product.update({
      where: { id },
      data: {
        name: dto.name,
        slug: dto.slug,
        description: dto.description,
        brandId: dto.brandId,
        categoryId: dto.categoryId,
        specs,
        warrantyMonths: dto.warrantyMonths,
        isActive: dto.isActive,
      },
      include: productInclude({}),
    });
    return mapProductDetail(product);
  }

  /** Soft delete: products with sales or stock history are never removed. */
  async deactivate(id: string) {
    await this.prisma.product.update({ where: { id }, data: { isActive: false } });
  }

  private buildWhere(q: ListProductsDto) {
    const variantWhere: Prisma.ProductVariantWhereInput = {
      isActive: true,
      priceMinor: { gte: q.minPrice, lte: q.maxPrice },
      AND: parseJsonFilter(q.attributes, 'attributes').map((attributes) => ({ attributes })),
    };

    const and: Prisma.ProductWhereInput[] = parseJsonFilter(q.specs, 'specs').map((specs) => ({
      specs,
    }));
    const brands = splitCsv(q.brand);
    if (brands.length) and.push({ brand: { slug: { in: brands } } });
    if (q.category) {
      and.push({ category: { OR: [{ slug: q.category }, { parent: { slug: q.category } }] } });
    }
    if (q.q) {
      and.push({
        OR: [
          { name: { contains: q.q, mode: 'insensitive' } },
          { brand: { name: { contains: q.q, mode: 'insensitive' } } },
          { variants: { some: { sku: { contains: q.q, mode: 'insensitive' } } } },
        ],
      });
    }

    // Public listing: active product with at least one active variant matching the variant filters
    const where: Prisma.ProductWhereInput = {
      isActive: true,
      variants: { some: variantWhere },
      AND: and,
    };
    return { where, variantWhere };
  }

  private async getCategory(id: string) {
    const category = await this.prisma.category.findUnique({
      where: { id },
      select: { slug: true, parent: { select: { slug: true } } },
    });
    if (!category) throw new BadRequestException('categoryId does not exist');
    return category;
  }

  private async assertBrandExists(id: string) {
    if ((await this.prisma.brand.count({ where: { id } })) === 0) {
      throw new BadRequestException('brandId does not exist');
    }
  }

  private validateSpecs(
    category: { slug: string; parent: { slug: string } | null },
    specs: unknown,
  ): Prisma.InputJsonObject {
    const result = getSpecsSchema(category.slug, category.parent?.slug).safeParse(specs);
    if (!result.success) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: `Invalid specs for category "${category.slug}"`,
        errors: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return result.data as Prisma.InputJsonObject;
  }
}
