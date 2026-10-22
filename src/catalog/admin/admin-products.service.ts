import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service'; // adjust the path
import { availableOf, summarizeVariants } from './admin-products.mapper';
import type { AdminProductsQueryDto } from './admin-products.dto';

@Injectable()
export class AdminProductsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: AdminProductsQueryDto) {
    const { q, categoryId, status, page, pageSize } = query;
    const where: Prisma.ProductWhereInput = {
      ...(status && { isActive: status === 'active' }),
      ...(categoryId && { categoryId }),
      ...(q && {
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { brand: { name: { contains: q, mode: 'insensitive' } } },
          { variants: { some: { sku: { contains: q, mode: 'insensitive' } } } },
        ],
      }),
    };

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.product.count({ where }),
      this.prisma.product.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          brand: { select: { id: true, name: true } },
          category: { select: { id: true, name: true, slug: true } },
          images: { orderBy: [{ isPrimary: 'desc' }, { position: 'asc' }], take: 1 },
          variants: { include: { inventory: true } },
        },
      }),
    ]);

    return {
      items: rows.map((p) => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        isActive: p.isActive,
        brand: p.brand,
        category: p.category,
        imageUrl: p.images[0]?.secureUrl ?? null,
        ...summarizeVariants(p.variants),
      })),
      total,
      page,
      pageSize,
      totalPages: Math.max(Math.ceil(total / pageSize), 1),
    };
  }

  async get(id: string) {
    const p = await this.prisma.product.findUnique({
      where: { id },
      include: {
        brand: { select: { id: true, name: true } },
        category: { select: { id: true, name: true, slug: true, parentId: true } },
        images: { orderBy: [{ isPrimary: 'desc' }, { position: 'asc' }] },
        variants: { orderBy: { createdAt: 'asc' }, include: { inventory: true } },
      },
    });
    if (!p) throw new NotFoundException('Product not found');

    return {
      id: p.id,
      name: p.name,
      slug: p.slug,
      description: p.description,
      specs: p.specs,
      warrantyMonths: p.warrantyMonths,
      isActive: p.isActive,
      brand: p.brand,
      category: p.category,
      images: p.images.map((i) => ({
        id: i.id,
        url: i.secureUrl,
        isPrimary: i.isPrimary,
        variantId: i.variantId,
      })),
      variants: p.variants.map((v) => ({
        id: v.id,
        sku: v.sku,
        name: v.name,
        attributes: v.attributes,
        priceMinor: v.priceMinor,
        isActive: v.isActive,
        onHand: v.inventory?.onHand ?? 0,
        reserved: v.inventory?.reserved ?? 0,
        available: availableOf(v.inventory),
      })),
    };
  }
}
