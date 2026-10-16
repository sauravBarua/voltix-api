import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { VARIANT_IMAGE_FOLDER } from '../../media/media.constants';
import { MediaService } from '../../media/media.service';
import { PrismaService } from '../../prisma/prisma.service';
import { mapVariant, variantSelect } from '../products/product.mapper';
import type { CreateVariantDto, UpdateVariantDto } from './variants.dto';

@Injectable()
export class VariantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
  ) {}

  async create(productId: string, dto: CreateVariantDto, file?: Express.Multer.File) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { id: true },
    });
    if (!product) throw new NotFoundException('Product not found');

    return this.media.withUploads(file ? [file] : [], VARIANT_IMAGE_FOLDER, async (images) => {
      const image = images[0] as (typeof images)[number] | undefined;
      // Variant + its stock row (+ image) are created atomically; stock starts at 0 (Phase 6 adds stock-in)
      const variant = await this.prisma.productVariant.create({
        data: {
          productId,
          sku: dto.sku,
          name: dto.name,
          attributes: dto.attributes as Prisma.InputJsonObject | undefined,
          priceMinor: dto.priceMinor,
          isActive: dto.isActive,
          inventory: { create: { reorderLevel: dto.reorderLevel } },
          images: image
            ? {
                create: {
                  productId,
                  secureUrl: image.secureUrl,
                  publicId: image.publicId,
                  position: 0,
                },
              }
            : undefined,
        },
        select: variantSelect,
      });
      return mapVariant(variant);
    });
  }

  async update(id: string, dto: UpdateVariantDto, file?: Express.Multer.File) {
    const { removeImage, ...fields } = dto;
    const existing = await this.prisma.productVariant.findUnique({
      where: { id },
      select: { productId: true, images: { select: { publicId: true } } },
    });
    if (!existing) throw new NotFoundException('Variant not found');

    const hasFieldChange = Object.values(fields).some((v) => v !== undefined);
    if (!hasFieldChange && !removeImage && !file)
      throw new BadRequestException('Nothing to update');

    const replaceImage = Boolean(file) || removeImage === true;

    const variant = await this.media.withUploads(
      file ? [file] : [],
      VARIANT_IMAGE_FOLDER,
      (images) => {
        const image = images[0] as (typeof images)[number] | undefined;
        return this.prisma.$transaction(async (tx) => {
          if (replaceImage) await tx.productImage.deleteMany({ where: { variantId: id } });
          if (image) {
            await tx.productImage.create({
              data: {
                productId: existing.productId,
                variantId: id,
                secureUrl: image.secureUrl,
                publicId: image.publicId,
                position: 0,
              },
            });
          }
          return tx.productVariant.update({
            where: { id },
            data: {
              name: fields.name,
              attributes: fields.attributes as Prisma.InputJsonObject | undefined,
              priceMinor: fields.priceMinor,
              isActive: fields.isActive,
            },
            select: variantSelect,
          });
        });
      },
    );

    // After the commit: old assets are removed only once the DB no longer points at them
    if (replaceImage) await this.media.deleteAssets(existing.images.map((i) => i.publicId));
    return mapVariant(variant);
  }

  /** Soft delete: variants with sales or stock history are never removed. */
  async deactivate(id: string) {
    await this.prisma.productVariant.update({ where: { id }, data: { isActive: false } });
  }
}
