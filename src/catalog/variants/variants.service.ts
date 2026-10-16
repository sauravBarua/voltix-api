import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { mapVariant, variantSelect } from '../products/product.mapper';
import type { CreateVariantDto, UpdateVariantDto } from './variants.dto';

@Injectable()
export class VariantsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(productId: string, dto: CreateVariantDto) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { id: true },
    });
    if (!product) throw new NotFoundException('Product not found');

    // Variant + its stock row are created atomically (stock starts at 0, Phase 6 adds stock-in)
    const variant = await this.prisma.productVariant.create({
      data: {
        productId,
        sku: dto.sku,
        name: dto.name,
        attributes: dto.attributes as Prisma.InputJsonObject | undefined,
        priceMinor: dto.priceMinor,
        isActive: dto.isActive,
        inventory: { create: { reorderLevel: dto.reorderLevel } },
      },
      select: variantSelect,
    });
    return mapVariant(variant);
  }

  async update(id: string, dto: UpdateVariantDto) {
    const variant = await this.prisma.productVariant.update({
      where: { id },
      data: {
        name: dto.name,
        attributes: dto.attributes as Prisma.InputJsonObject | undefined,
        priceMinor: dto.priceMinor,
        isActive: dto.isActive,
      },
      select: variantSelect,
    });
    return mapVariant(variant);
  }

  /** Soft delete: variants with sales or stock history are never removed. */
  async deactivate(id: string) {
    await this.prisma.productVariant.update({ where: { id }, data: { isActive: false } });
  }
}
