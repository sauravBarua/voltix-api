import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { AdminVariantsQueryDto } from './admin-variants.dto';
import { toAdminVariantRow } from './admin-variants.mapper';

@Injectable()
export class AdminVariantsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: AdminVariantsQueryDto) {
    const { q, productId, status, page, pageSize } = query;
    const where: Prisma.ProductVariantWhereInput = {
      ...(productId && { productId }),
      ...(status && { isActive: status === 'active' }),
      ...(q && {
        OR: [
          { sku: { contains: q, mode: 'insensitive' } },
          { name: { contains: q, mode: 'insensitive' } },
          { product: { name: { contains: q, mode: 'insensitive' } } },
        ],
      }),
    };

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.productVariant.count({ where }),
      this.prisma.productVariant.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          inventory: { select: { onHand: true, reserved: true, reorderLevel: true } },
          product: {
            select: {
              id: true,
              name: true,
              slug: true,
              isActive: true,
              brand: { select: { name: true } },
            },
          },
        },
      }),
    ]);

    return {
      items: rows.map(toAdminVariantRow),
      total,
      page,
      pageSize,
      totalPages: Math.max(Math.ceil(total / pageSize), 1),
    };
  }
}
